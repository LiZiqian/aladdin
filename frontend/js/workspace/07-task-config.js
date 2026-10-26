/* ========================================
   数字治理平台 V7 - 任务配置模块
   含任务池创建·计划配置·样机配置·配置弹窗
   ======================================== */

app.registerModule("workspace.taskConfig", {

  /**
   * 解析任务对应的 progress：
   * 1) 优先返回阶段策略池中仍存在的 progress（保持与最新策略联动）；
   * 2) 若策略池中已删除（任务创建后独立执行），用任务自身快照字段合成只读 pseudo-progress，
   *    保证「配置/分配/计划」等入口不会因为找不到 progress 而静默失效。
   * 返回 { progress, fromSnapshot }
   */
  resolveTaskProgress(stage, task, progressId = "") {
    const live = (stage?.progress || []).find(x => x.id === (progressId || task?.progressId));
    if (live) return { progress: live, fromSnapshot: false };
    if (!task) return { progress: null, fromSnapshot: false };
    const pseudo = {
      id: task.progressId || `snapshot_${task.id}`,
      strategyId: task.strategyId || "",
      category: task.category || "",
      testItem: task.testItem || "",
      skuIndex: task.skuIndex || 1,
      sampleSize: task.requiredSampleCount || "",
      _snapshot: true
    };
    return { progress: pseudo, fromSnapshot: true };
  },

  createTaskFromProgress(stage, progress, seed = {}) {
    if (!stage || !progress) return null;
    if (!Array.isArray(stage.tasks)) stage.tasks = [];
    const skuIndex = progress.skuIndex || 1;
    const task = {
      id: Utils.id("task_"),
      progressId: progress.id,
      strategyId: progress.strategyId || "",
      category: progress.category || "",
      testItem: progress.testItem || "",
      skuIndex,
      skuName: (stage.skuNames || [])[skuIndex - 1] || `SKU${skuIndex}`,
      owner: seed.owner || "",
      planStartDate: seed.planStartDate || "",
      planEndDate: seed.planEndDate || "",
      planDate: seed.planDate || seed.planStartDate || "",
      status: seed.status || "待下发",
      sampleIds: [...(seed.sampleIds || [])],
      deviceIds: [...(seed.deviceIds || [])],
      removedSampleRecords: [],
      sampleFaultRecords: [],
      resultUploads: [],
      createdAt: Utils.now(),
      logs: [],
      completed: false,
      requiredSampleCount: this.getProgressRequiredSampleCount(stage, progress)
    };
    stage.tasks.push(task);
    if (seed.log !== false) {
      this.addTaskLog(task, seed.logAction || "新增待下发任务", {
        user: seed.user || "管理员",
        reason: seed.reason || "从阶段配置测试池新增",
        toStatus: this.taskFlowStatus(task)
      });
    }
    return task;
  },

  openAddTasksFromPoolModal() {
    const project = this.currentProject();
    const stage = this.currentStage();
    if (!project || !stage) return;
    const pool = (stage.progress || []).filter(p => p && p.testItem);
    if (!pool.length) {
      alert("当前阶段测试池为空。请先在「配置测试用例集」的测试策略配置中新增测试项。");
      return;
    }
    const taskCountByProgress = new Map(Object.entries(stage.progressTaskCounts || {}));
    if (!stage.progressTaskCounts) (stage.tasks || []).forEach(t => {
      if (!t.progressId || t.archived || t.deletedAt) return;
      taskCountByProgress.set(t.progressId, (taskCountByProgress.get(t.progressId) || 0) + 1);
    });
    const rows = pool.map((p, idx) => {
      const required = this.getProgressRequiredSampleCount(stage, p);
      const existing = taskCountByProgress.get(p.id) || 0;
      return `
        <tr>
          <td style="text-align:center"><input class="task-pool-check" type="checkbox" data-index="${idx}" data-app-action="task-pool-selection" data-app-events="change" style="width:auto"></td>
          <td>${Utils.esc(stage.skuNames?.[p.skuIndex - 1] || `SKU${p.skuIndex}`)}</td>
          <td class="compact-cell"><b>${Utils.esc(this.taskCategoryItemText(p.category, p.testItem))}</b></td>
          <td>${required === null ? "-" : `${required} 台`}</td>
          <td>${existing ? `${existing} 个` : "-"}</td>
          <td><input class="task-pool-count" data-index="${idx}" type="number" min="1" step="1" value="1" data-app-action="task-pool-selection" data-app-events="input"></td>
        </tr>`;
    }).join("");
    const modalId = this.showModal("新增任务", `
      <div class="path">从当前阶段测试池选择测试项生成真实任务。可重复新增，新增后默认均为"待下发"。</div>
      <div class="task-pool-toolbar">
        <button type="button" class="btn btn-sm btn-outline" data-app-action="task-pool-check-all" data-value="1">全选</button>
        <button type="button" class="btn btn-sm btn-outline" data-app-action="task-pool-check-all" data-value="0">清空</button>
        <span id="taskPoolSelectionHint" class="task-pool-hint">已选 0 项，将新增 0 个任务</span>
      </div>
      <div class="table-wrap task-pool-table"><table>
        <thead><tr><th style="width:46px"></th><th>方案(SKU)</th><th>类别/用例</th><th>样机数</th><th>已有任务</th><th>新增次数</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    `, async () => {
      const selected = [...document.querySelectorAll(".task-pool-check:checked")];
      if (!selected.length) {
        this.clearFieldValidationMarks();
        this.markFieldInvalid(document.getElementById("taskPoolSelectionHint"), "请至少选择一个测试项。");
        return true;
      }
      const queue = [];
      selected.forEach(cb => {
        const idx = Number(cb.dataset.index);
        const progress = pool[idx];
        const input = document.querySelector(`.task-pool-count[data-index="${idx}"]`);
        const count = Math.max(1, Utils.parsePositiveInt(input?.value) || 1);
        for (let i = 0; i < count; i++) {
          queue.push(progress);
        }
      });
      const newTasks = queue
        .map(progress => this.createTaskFromProgress(stage, progress, { status: "待下发" }))
        .filter(Boolean);
      const newTaskIds = new Set(newTasks.map(task => task.id));
      const saved = await this.commitTaskBatchMutation(project, stage, newTasks, {
        action: "create_tasks_batch",
        remark: `从测试池批量新增任务：${newTasks.length} 个`,
        user: "管理员",
        createIfMissing: true
      });
      if (!saved) {
        stage.tasks = (stage.tasks || []).filter(task => !newTaskIds.has(task.id));
        return true;
      }
      Utils.toast(`已新增 ${newTasks.length} 个待下发任务。`);
      return false;
    });
    setTimeout(() => {
      if (modalId != null && this._currentModalId !== modalId) return;
      this.updateTaskPoolSelectionCount();
    }, 0);
  },

  setTaskPoolChecked(checked) {
    document.querySelectorAll(".task-pool-check").forEach(cb => { cb.checked = checked; });
    this.updateTaskPoolSelectionCount();
  },

  updateTaskPoolSelectionCount() {
    const hint = document.getElementById("taskPoolSelectionHint");
    if (!hint) return;
    const selected = [...document.querySelectorAll(".task-pool-check:checked")];
    const taskCount = selected.reduce((sum, cb) => {
      const idx = cb.dataset.index;
      const input = document.querySelector(`.task-pool-count[data-index="${idx}"]`);
      return sum + Math.max(1, Utils.parsePositiveInt(input?.value) || 1);
    }, 0);
    hint.innerText = `已选 ${selected.length} 项，将新增 ${taskCount} 个任务`;
  },

  // ==================== 任务操作 ====================
  ensurePlanTask(stage, progress, seed = {}) {
    if (!stage || !progress) return null;
    if (!Array.isArray(stage.tasks)) stage.tasks = [];
    let task = seed.taskId ? stage.tasks.find(t => t.id === seed.taskId) : null;
    if (task) return task;
    task = {
      id: Utils.id("task_"),
      progressId: progress.id,
      strategyId: progress.strategyId || "",
      category: progress.category || "",
      testItem: progress.testItem,
      skuIndex: progress.skuIndex,
      owner: seed.owner || "",
      planStartDate: seed.planStartDate || "",
      planEndDate: seed.planEndDate || "",
      planDate: seed.planStartDate || "",
      status: seed.status || "待下发",
      sampleIds: [...(seed.sampleIds || [])],
      removedSampleRecords: [],
      sampleFaultRecords: [],
      resultUploads: [],
      createdAt: Utils.now(),
      logs: [],
      completed: false,
      requiredSampleCount: this.getProgressRequiredSampleCount(stage, progress)
    };
    stage.tasks.push(task);
    return task;
  },

  async assignPlanTaskSamples(projectId, stageId, progressId, taskId = "") {
    const p = this.findProjectRecord(projectId);
    const s = p?.stages.find(x => x.id === stageId);
    let t = taskId ? s?.tasks.find(x => x.id === taskId) : null;
    const progress = (s?.progress || []).find(x => x.id === progressId) || this.resolveTaskProgress(s, t, progressId).progress;
    if (!p || !s || !progress) return;
    if (t && this.taskFlowStatus(t) !== "待下发") { alert("只有未下发任务可以分配或重新分配样机。"); return; }
    const selectedIds = t?.sampleIds || [];
    const sampleCards = this.buildTaskSamplePickerHtml(selectedIds, "assignSamplePick", "assignProgress", "assignSampleLimitHint", t?.id || "");
    const modalId = this.showModal(t?.sampleIds?.length ? "重新分配样机" : "分配样机", `
      <input type="hidden" id="assignProgress" value="${Utils.esc(progress.id)}">
      <div class="path">计划任务：${Utils.esc(this.getProgressDisplayName(s, progress))}</div>
      <div id="assignSampleLimitHint" class="sample-limit-hint"></div>
      <div class="form-group"><label class="req">选择样机</label><div class="dispatch-sample-select">${sampleCards}</div></div>
    `, async () => {
      // A failed save can replace the local state snapshot while this modal stays open.
      const p = this.findProjectRecord(projectId);
      const s = p?.stages.find(x => x.id === stageId);
      let t = taskId ? s?.tasks.find(x => x.id === taskId) : null;
      const progress = (s?.progress || []).find(x => x.id === progressId) || this.resolveTaskProgress(s, t, progressId).progress;
      if (!p || !s || !progress) return true;
      if (t && this.taskFlowStatus(t) !== "待下发") { alert("只有未下发任务可以分配或重新分配样机。"); return true; }
      const operator = t?.owner || "管理员";
      const sampleIds = this.getSelectedTaskSampleIds("assignSamplePick");
      const check = this.validateTaskSampleSelection(progress, sampleIds, "样机分配");
      if (!check.ok) { alert(check.msg); return true; }
      const oldSampleIds = [...(t?.sampleIds || [])];
      const sampleChanged = !t || this.taskSampleIdListKey(oldSampleIds) !== this.taskSampleIdListKey(sampleIds);
      if (t && !sampleChanged) {
        Utils.toast("未检测到变更");
        return false;
      }
      const epoch = this._dataSnapshotEpoch || 0;
      if (typeof this.prepareTaskActionSamples === "function"
        && !await this.prepareTaskActionSamples(t || { id: `plan:${progress.id}`, sampleSnapshots: {} }, [...new Set([...oldSampleIds, ...sampleIds])], "保存样机分配")) return true;
      if ((this._dataSnapshotEpoch || 0) !== epoch || this.findProjectRecord(projectId) !== p
        || p.stages.find(stage => stage.id === stageId) !== s
        || (t && (s.tasks.find(task => task.id === taskId) !== t || this.taskFlowStatus(t) !== "待下发"))) return true;
      const mutationSnapshot = this.taskMutationSnapshot();
      const wasNew = !t;
      t = t || this.ensurePlanTask(s, progress);
      const removed = oldSampleIds.filter(id => !sampleIds.includes(id));
      const added = sampleIds.filter(id => !oldSampleIds.includes(id));
      t.sampleIds = sampleIds;
      t.requiredSampleCount = check.required;
      if (!t.status) this.repairTaskStatus(t, "待下发");
      removed.forEach(id => {
        this.recordTaskSampleReservation(id, { user: operator, source: "取消样机预约", reason: "未下发任务调整样机", projectId: p.id, stageId: s.id, taskId: t.id, testItem: t.testItem });
      });
      added.forEach(id => this.recordTaskSampleReservation(id, { user: operator, source: "预约任务样机", reason: `计划 ${t.planStartDate || '未设置'} ~ ${t.planEndDate || '未设置'}`, projectId: p.id, stageId: s.id, taskId: t.id, testItem: t.testItem }));
      this.addTaskLog(t, oldSampleIds.length ? "重新分配样机" : "分配样机", { user: operator, reason: "未下发任务样机配置", detail: `样机：${sampleIds.map(id => this.findSample(id)?.sample.sampleNo || id).join(", ")}` });
      const saved = await this.commitTaskMutation(p, s, t, {
        action: oldSampleIds.length ? "reassign_task_samples" : "assign_task_samples",
        remark: "未下发任务样机配置",
        user: operator,
        createIfMissing: wasNew,
        sampleIdsForMutation: [...new Set([...oldSampleIds, ...sampleIds])]
      });
      if (!saved) {
        this.restoreFailedTaskMutation(mutationSnapshot, { render: false });
        return true;
      }
      Utils.toast(oldSampleIds.length ? "样机已重新分配" : "样机已分配");
      return false;
    }, "确认", { className: "assign-sample-modal" });
    setTimeout(() => {
      if (modalId != null && this._currentModalId !== modalId) return;
      this.initTaskSamplePicker("assignSamplePick");
      this.updateTaskSampleLimitUI('assignProgress', 'assignSamplePick', 'assignSampleLimitHint');
    }, 0);
  },

  setPlanTaskSchedule(projectId, stageId, progressId, taskId = "") {
    const p = this.findProjectRecord(projectId);
    const s = p?.stages.find(x => x.id === stageId);
    let t = taskId ? s?.tasks.find(x => x.id === taskId) : null;
    const progress = (s?.progress || []).find(x => x.id === progressId) || this.resolveTaskProgress(s, t, progressId).progress;
    if (!p || !s || !progress) return;
    if (t && this.taskFlowStatus(t) !== "待下发") { alert("只有未下发任务可以修改计划时间。"); return; }
    const planStartDate = t?.planStartDate || t?.planDate || "";
    const planEndDate = t?.planEndDate || t?.endDate || "";
    // P1.4：项目还没人员时，直接给个红色提示和快速新增入口
    const activeMembers = this.projectActiveMembers(p, "tester");
    const memberMissingHint = activeMembers.length
      ? ""
      : `<div class="field-error" data-task-member-missing="1" style="display:block;margin-top:6px">
          ⚠ 项目测试人员名单为空，无法选择执行人。
          <button type="button" class="btn btn-sm btn-add" style="margin-left:8px"
            data-app-action="task-config-member-add">立即新增人员</button>
        </div>`;
    this.showModal("设置计划时间", `
      <div class="path">计划任务：${Utils.esc(this.getProgressDisplayName(s, progress))}</div>
      <div class="form-group">
        <label class="req" style="color:var(--muted);font-weight:700">执行人<span class="req-star">*</span></label>
        ${this.projectMemberSelectHtml("planOwner", t?.owner || "", "请选择执行人", { scope: "tester" })}
        ${memberMissingHint}
      </div>
      <div class="form-row">
        <div class="form-group"><label class="req" style="color:var(--muted);font-weight:700">计划开始时间<span class="req-star">*</span></label><input type="date" id="planStartDate" value="${Utils.esc(planStartDate)}"></div>
        <div class="form-group"><label class="req" style="color:var(--muted);font-weight:700">计划终止时间<span class="req-star">*</span></label><input type="date" id="planEndDate" value="${Utils.esc(planEndDate)}"></div>
      </div>
    `, async () => {
      const p = this.findProjectRecord(projectId);
      const s = p?.stages.find(x => x.id === stageId);
      let t = taskId ? s?.tasks.find(x => x.id === taskId) : null;
      const progress = (s?.progress || []).find(x => x.id === progressId) || this.resolveTaskProgress(s, t, progressId).progress;
      if (!p || !s || !progress) return true;
      if (t && this.taskFlowStatus(t) !== "待下发") { alert("只有未下发任务可以修改计划时间。"); return true; }
      const owner = document.getElementById("planOwner").value.trim();
      const start = document.getElementById("planStartDate").value;
      const end = document.getElementById("planEndDate").value;
      this.clearFieldValidationMarks();
      const ownerCheck = this.validatePersonForScope(owner, "tester", "执行人");
      if (!ownerCheck.ok) { this.markFieldInvalid(document.getElementById("planOwner"), ownerCheck.msg); return true; }
      if (!start || !end) {
        if (!start) this.markFieldInvalid(document.getElementById("planStartDate"), "必须填写计划开始时间");
        if (!end) this.markFieldInvalid(document.getElementById("planEndDate"), "必须填写计划终止时间");
        return true;
      }
      if (start > end) {
        this.markFieldInvalid(document.getElementById("planEndDate"), "计划终止时间不能早于计划开始时间");
        return true;
      }
      if (t && !this.isTaskChangePayloadChanged(t, { owner, planStartDate: start, planEndDate: end })) {
        Utils.toast("未检测到变更");
        return false;
      }
      const mutationSnapshot = this.taskMutationSnapshot();
      const wasNew = !t;
      t = t || this.ensurePlanTask(s, progress, { owner, planStartDate: start, planEndDate: end });
      t.owner = owner;
      t.planStartDate = start;
      t.planEndDate = end;
      t.planDate = start;
      if (!t.status) this.repairTaskStatus(t, "待下发");
      this.addTaskLog(t, "设置计划时间", { user: owner, reason: `计划开始 ${start}，计划终止 ${end}` });
      const saved = await this.commitTaskMutation(p, s, t, {
        action: "set_task_plan",
        remark: "设置任务计划时间",
        user: owner,
        createIfMissing: wasNew,
        sampleIdsForMutation: []
      });
      if (!saved) {
        this.restoreFailedTaskMutation(mutationSnapshot, { render: false });
        return true;
      }
      Utils.toast("计划配置已保存");
      return false;
    });
  },

  taskConfigDisplayName(stage, progress, task) {
    const category = task?.category || progress?.category || "";
    const testItem = task?.testItem || progress?.testItem || "";
    if (category && testItem) return `${category} -> ${testItem}`;
    if (testItem) return testItem;
    if (category) return category;
    return "未知测试项";
  },

  taskConfigTitlebarNode(stage, progress, task) {
    const titlebar = document.createElement("div");
    titlebar.className = "task-config-titlebar";

    const title = document.createElement("span");
    title.textContent = "任务配置";

    const context = document.createElement("span");
    context.className = "task-config-title-context";
    context.textContent = `计划任务：${this.taskConfigDisplayName(stage, progress, task)}`;

    titlebar.append(title, context);
    return titlebar;
  },

  async openTaskConfigPanel(projectId, stageId, progressId, taskId = "", initialTab = "plan") {
    const p = this.findProjectRecord(projectId);
    const s = p?.stages.find(x => x.id === stageId);
    const t = taskId ? s?.tasks.find(x => x.id === taskId) : null;
    const progress = (s?.progress || []).find(x => x.id === progressId) || this.resolveTaskProgress(s, t, progressId).progress;
    if (!p || !s || !progress) return;
    if (t && this.taskFlowStatus(t) !== "待下发") { alert("只有未下发任务可以修改配置。"); return; }
    const html = this.taskConfigPanelHtml(p, s, progress, t, initialTab);
    const modalId = this.showModal("任务配置", html,
      () => this.saveTaskConfigAll(projectId, stageId, progressId, taskId),
      "保存并关闭",
      {
        className: "task-config-modal",
        hideCancel: false,
        cancelText: "取消",
        onCancel: () => {
          if (!this.hasUnsavedTaskConfigChanges(projectId, stageId, progressId, taskId)) return false;
          this.showConfirm("有未保存的修改，确定放弃吗？", () => this.closeModal(), {
            title: "放弃修改", okText: "放弃", okClass: "btn btn-danger", cancelText: "继续编辑"
          });
          return true;
        }
      }
    );
    // 标题栏替换为左右布局
    setTimeout(() => {
      if (modalId != null && this._currentModalId !== modalId) return;
      const titleEl = document.getElementById("modalTitle");
      if (titleEl) {
        titleEl.textContent = "";
        titleEl.append(this.taskConfigTitlebarNode(s, progress, t));
      }
    }, 0);
    // 若默认进入样机配置页，初始化数量提示
    setTimeout(() => {
      if (modalId != null && this._currentModalId !== modalId) return;
      this.initTaskSamplePicker("tcSamplePick");
      this.refreshTaskDevicePicker?.();
      if (initialTab === "sample") this.updateTaskSampleLimitUI("tcSampleProgress", "tcSamplePick", "tcSampleLimitHint");
    }, 0);
  },

  taskConfigPanelHtml(project, stage, progress, task, activeTab) {
    const planActive = activeTab === "plan" ? "active" : "";
    const sampleActive = activeTab === "sample" ? "active" : "";
    const deviceActive = activeTab === "device" ? "active" : "";
    return `<div class="task-config-shell">
      <div class="task-config-nav" role="tablist" aria-label="任务配置步骤">
        <button type="button" id="tcTabPlan" class="task-config-nav-card ${planActive}" role="tab" aria-controls="tcPanelPlan" aria-selected="${activeTab === "plan"}" tabindex="${activeTab === "plan" ? "0" : "-1"}" data-app-action="task-config-tab" data-value="plan">
          <b>计划配置</b>
        </button>
        <button type="button" id="tcTabSample" class="task-config-nav-card ${sampleActive}" role="tab" aria-controls="tcPanelSample" aria-selected="${activeTab === "sample"}" tabindex="${activeTab === "sample" ? "0" : "-1"}" data-app-action="task-config-tab" data-value="sample">
          <b>样机配置</b>
        </button>
        <button type="button" id="tcTabDevice" class="task-config-nav-card ${deviceActive}" role="tab" aria-controls="tcPanelDevice" aria-selected="${activeTab === "device"}" tabindex="${activeTab === "device" ? "0" : "-1"}" data-app-action="task-config-tab" data-value="device"><b>测试设备配置</b></button>
      </div>
      <div class="task-config-main">
        <div class="task-config-panel ${planActive}" id="tcPanelPlan" role="tabpanel" aria-labelledby="tcTabPlan" aria-hidden="${activeTab !== "plan"}">
          ${this.taskPlanConfigPanelHtml(project, stage, progress, task)}
        </div>
        <div class="task-config-panel ${sampleActive}" id="tcPanelSample" role="tabpanel" aria-labelledby="tcTabSample" aria-hidden="${activeTab !== "sample"}">
          ${this.taskSampleConfigPanelHtml(project, stage, progress, task)}
        </div>
        <div class="task-config-panel ${deviceActive}" id="tcPanelDevice" role="tabpanel" aria-labelledby="tcTabDevice" aria-hidden="${activeTab !== "device"}">${this.taskDeviceConfigPanelHtml?.(task) || ""}</div>
      </div>
    </div>`;
  },

  taskPlanConfigPanelHtml(project, stage, progress, task) {
    const t = task;
    const planStartDate = t?.planStartDate || t?.planDate || "";
    const planEndDate = t?.planEndDate || t?.endDate || "";
    const activeMembers = this.projectActiveMembers(project, "tester");
    const memberMissingHint = activeMembers.length
      ? ""
      : `<div class="field-error" data-task-member-missing="1" style="display:block;margin-top:6px">
          ⚠ 项目测试人员名单为空，无法选择执行人。
          <button type="button" class="btn btn-sm btn-add" style="margin-left:8px"
            data-app-action="task-config-member-add">立即新增人员</button>
        </div>`;
    return `
      <div class="form-group">
        <label>执行人</label>
        ${this.projectMemberSelectHtml("tcPlanOwner", t?.owner || "", "请选择执行人", { scope: "tester" })}
        ${memberMissingHint}
      </div>
      <div class="form-row">
        <div class="form-group"><label>计划开始时间</label><input type="date" id="tcPlanStartDate" value="${Utils.esc(planStartDate)}"></div>
        <div class="form-group"><label>计划终止时间</label><input type="date" id="tcPlanEndDate" value="${Utils.esc(planEndDate)}"></div>
      </div>
`;
  },

  taskSampleConfigPanelHtml(project, stage, progress, task) {
    const t = task;
    const selectedIds = t?.sampleIds || [];
    const selectedHeaderHtml = `<div class="task-sample-label-row task-sample-label-row-compact">
      <label>任务样机数：</label>
      <div id="tcSampleLimitHint" class="sample-limit-hint sample-limit-global" title="当前已选 / 任务要求样机数"></div>
      ${this.taskSampleScheduleHintHtml()}
    </div>`;
    const sampleCards = this.buildTaskSamplePickerHtml(selectedIds, "tcSamplePick", "tcSampleProgress", "tcSampleLimitHint", t?.id || "", {
      planStartInputId: "tcPlanStartDate", planEndInputId: "tcPlanEndDate", showScheduleHint: false, selectedHeaderHtml
    });
    return `
      <input type="hidden" id="tcSampleProgress" value="${Utils.esc(progress.id)}">
      <div class="form-group task-sample-config-group">
        <div class="dispatch-sample-select task-config-sample-scroll">${sampleCards}</div>
      </div>
`;
  },

  refreshTaskConfigMemberPickers(selectedIdentity = "") {
    ["planOwner", "tcPlanOwner"].forEach(id => {
      const input = document.getElementById(id);
      if (!input) return;
      const scope = input.dataset.memberScope || "tester";
      const projectId = input.dataset.memberProjectId || this.currentProject()?.id || "";
      const placeholder = input.getAttribute("placeholder") || "请选择执行人";
      const fragment = this.htmlFragment(this.projectMemberSelectHtml(id, selectedIdentity, placeholder, {
        scope,
        projectId
      }));
      if (!fragment) return;
      input.replaceWith(...Array.from(fragment.childNodes || []));
      document.querySelector(`#modalBody [data-task-member-missing="1"]`)?.remove();
      document.getElementById(id)?.focus();
    });
  },


  async saveTaskConfigAll(projectId, stageId, progressId, taskId) {
    const p = this.findProjectRecord(projectId);
    const s = p?.stages.find(x => x.id === stageId);
    let t = taskId ? s?.tasks.find(x => x.id === taskId) : null;
    const progress = (s?.progress || []).find(x => x.id === progressId) || this.resolveTaskProgress(s, t, progressId).progress;
    if (!p || !s || !progress) return true;
    if (t && this.taskFlowStatus(t) !== "待下发") { alert("任务状态已变化，请关闭后刷新。"); return true; }
    // 读取 plan 字段
    const owner = document.getElementById("tcPlanOwner")?.value.trim() || "";
    const start = document.getElementById("tcPlanStartDate")?.value || "";
    const end = document.getElementById("tcPlanEndDate")?.value || "";
    // 读取 sample 字段
    const sampleIds = this.getSelectedTaskSampleIds("tcSamplePick");
    const deviceIds = this.getSelectedTaskDeviceIds?.() || [...(t?.deviceIds || [])];
    const deviceChanged = JSON.stringify([...(t?.deviceIds || [])].sort()) !== JSON.stringify([...deviceIds].sort());
    const check = this.validateTaskSampleSelection(progress, sampleIds, "样机分配");
    // 验证 plan
    this.clearFieldValidationMarks();
    const ownerCheck = this.validatePersonForScope(owner, "tester", "执行人");
    if (!ownerCheck.ok) { this.markTaskPlanConfigInvalid(document.getElementById("tcPlanOwner"), ownerCheck.msg); return true; }
    if (!start || !end) {
      if (!start) this.markTaskPlanConfigInvalid(document.getElementById("tcPlanStartDate"), "必须填写计划开始时间");
      if (!end) this.markTaskPlanConfigInvalid(document.getElementById("tcPlanEndDate"), "必须填写计划终止时间");
      return true;
    }
    if (start > end) { this.markTaskPlanConfigInvalid(document.getElementById("tcPlanEndDate"), "计划终止时间不能早于计划开始时间"); return true; }
    // 验证 sample — 文字提示 + 自动切到样机 Tab，不弹 alert，不标红计数胶囊
    if (!check.ok) {
      const pickerState = this.taskSamplePickerState("tcSamplePick");
      if (pickerState) pickerState.selectionError = check.msg;
      this.switchTaskConfigTab("sample");
      return true;
    }
    // 变更检测（合并 payload）
    if (t && !deviceChanged && !this.isTaskChangePayloadChanged(t, { owner, planStartDate: start, planEndDate: end, sampleIds })) {
      Utils.toast("未检测到变更");
      return false;
    }
    const samplesBeforeSave = [...(t?.sampleIds || [])];
    const epoch = this._dataSnapshotEpoch || 0;
    if (typeof this.prepareTaskActionSamples === "function"
      && !await this.prepareTaskActionSamples(t || { id: `plan:${progress.id}`, sampleSnapshots: {} }, [...new Set([...samplesBeforeSave, ...sampleIds])], "保存任务配置")) return true;
    if ((this._dataSnapshotEpoch || 0) !== epoch || this.findProjectRecord(projectId) !== p
      || p.stages.find(stage => stage.id === stageId) !== s
      || (t && (s.tasks.find(task => task.id === taskId) !== t || this.taskFlowStatus(t) !== "待下发"))) return true;
    const mutationSnapshot = this.taskMutationSnapshot();
    // ensure（task 已存在，仅防御）
    const wasNew = !t;
    t = t || this.ensurePlanTask(s, progress);
    // The server validates reservations and creates authoritative snapshots/logs.
    t.deviceIds = deviceIds;
    // 检测各维度变更
    const planChanged = (t.owner || "") !== owner
      || (t.planStartDate || t.planDate || "") !== start
      || (t.planEndDate || t.endDate || "") !== end;
    const oldSampleIds = [...(t.sampleIds || [])];
    const sampleChanged = this.taskSampleIdListKey(oldSampleIds) !== this.taskSampleIdListKey(sampleIds);
    // 施加 plan 变更
    if (planChanged) {
      t.owner = owner;
      t.planStartDate = start;
      t.planEndDate = end;
      t.planDate = start;
    }
    // 施加 sample 变更
    if (sampleChanged) {
      const operator = owner || t.owner || "管理员";
      const removed = oldSampleIds.filter(id => !sampleIds.includes(id));
      const added = sampleIds.filter(id => !oldSampleIds.includes(id));
      t.sampleIds = sampleIds;
      t.requiredSampleCount = check.required;
      removed.forEach(id => {
        this.recordTaskSampleReservation(id, { user: operator, source: "取消样机预约", reason: "未下发任务调整样机", projectId: p.id, stageId: s.id, taskId: t.id, testItem: t.testItem });
      });
      added.forEach(id => this.recordTaskSampleReservation(id, { user: operator, source: "预约任务样机", reason: `计划 ${start} ~ ${end}`, projectId: p.id, stageId: s.id, taskId: t.id, testItem: t.testItem }));
    }
    // 状态 + 日志
    if (!t.status) this.repairTaskStatus(t, "待下发");
    if (planChanged) {
      this.addTaskLog(t, "设置计划时间", { user: owner, reason: `计划开始 ${start}，计划终止 ${end}` });
    }
    if (sampleChanged) {
      this.addTaskLog(t, oldSampleIds.length ? "重新分配样机" : "分配样机", {
        user: owner || t.owner || "管理员",
        reason: "未下发任务样机配置",
        detail: `样机：${sampleIds.map(id => this.findSample(id)?.sample.sampleNo || id).join(", ")}`
      });
    }
    // 统一持久化
    const saved = await this.commitTaskMutation(p, s, t, {
      action: wasNew ? "create_task_config" : "save_task_config",
      remark: "保存任务配置",
      user: owner || t.owner || "管理员",
      createIfMissing: wasNew,
      sampleIdsForMutation: sampleChanged ? [...new Set([...oldSampleIds, ...sampleIds])] : []
    });
    if (!saved) {
      this.restoreFailedTaskMutation(mutationSnapshot, { render: false });
      this.loadTaskSamplePickerPage("tcSamplePick");
      this.refreshTaskDevicePicker?.();
      return true;
    }
    if (deviceChanged || (planChanged && sampleChanged)) Utils.toast("任务配置已保存");
    else if (planChanged) Utils.toast("计划配置已保存");
    else Utils.toast("样机配置已保存");
    return false;
  },

  markTaskPlanConfigInvalid(el, message) {
    const modalId = this._currentModalId;
    const showPlan = () => {
      if (modalId != null && this._currentModalId !== modalId) return;
      this.switchTaskConfigTab("plan");
    };
    showPlan();
    this.markFieldInvalid(el, message);
    el?.focus?.({ preventScroll: true });
    if (typeof setTimeout === "function") {
      setTimeout(showPlan, 0);
      setTimeout(showPlan, 120);
    }
  },

  hasUnsavedTaskConfigChanges(projectId, stageId, progressId, taskId) {
    const p = this.findProjectRecord(projectId);
    const s = p?.stages.find(x => x.id === stageId);
    const t = taskId ? s?.tasks.find(x => x.id === taskId) : null;
    if (!p || !s) return false;
    // Plan fields
    const domOwner = (document.getElementById("tcPlanOwner")?.value || "").trim();
    const domStart = document.getElementById("tcPlanStartDate")?.value || "";
    const domEnd = document.getElementById("tcPlanEndDate")?.value || "";
    const origOwner = (t?.owner || "").trim();
    const origStart = t?.planStartDate || t?.planDate || "";
    const origEnd = t?.planEndDate || "";
    if (domOwner !== origOwner || domStart !== origStart || domEnd !== origEnd) return true;
    // Sample fields
    const domSampleIds = this.getSelectedTaskSampleIds("tcSamplePick").sort().join(",");
    const origSampleIds = (t?.sampleIds || []).slice().sort().join(",");
    if (domSampleIds !== origSampleIds) return true;
    const domDeviceIds = this.getSelectedTaskDeviceIds?.() || [...(t?.deviceIds || [])];
    if (JSON.stringify([...domDeviceIds].sort()) !== JSON.stringify([...(t?.deviceIds || [])].sort())) return true;
    return false;
  },

  switchTaskConfigTab(tab) {
    document.querySelectorAll(".task-config-nav-card").forEach(el => {
      el.classList.remove("active");
      el.setAttribute("aria-selected", "false");
      el.tabIndex = -1;
    });
    document.querySelectorAll(".task-config-panel").forEach(el => {
      el.classList.remove("active");
      el.setAttribute("aria-hidden", "true");
    });
    const navCards = document.querySelectorAll(".task-config-nav-card");
    const activeNav = navCards[tab === "plan" ? 0 : tab === "device" ? 2 : 1];
    if (activeNav) {
      activeNav.classList.add("active");
      activeNav.setAttribute("aria-selected", "true");
      activeNav.tabIndex = 0;
    }
    const panel = document.getElementById(tab === "plan" ? "tcPanelPlan" : tab === "device" ? "tcPanelDevice" : "tcPanelSample");
    if (panel) {
      panel.classList.add("active");
      panel.setAttribute("aria-hidden", "false");
    }
    if (tab === "sample") {
      this.loadTaskSamplePickerPage("tcSamplePick");
      this.updateTaskSampleLimitUI("tcSampleProgress", "tcSamplePick", "tcSampleLimitHint");
    }
  },

});
