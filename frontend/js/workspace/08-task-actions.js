/* ========================================
   数字治理平台 V7 - 任务操作模块
   含启动·阻塞·变更·删除·问题统计
   ======================================== */

app.registerModule("workspace.taskActions", {

  taskActionMutationSnapshot() {
    if (typeof this.taskMutationSnapshot === "function") return this.taskMutationSnapshot();
    return {
      data: this.dataSnapshot(),
      baseData: this.cloneData(this._baseData || this.dataSnapshot())
    };
  },

  restoreFailedTaskActionMutation(snapshot, options = {}) {
    if (typeof this.restoreFailedTaskMutation === "function") {
      return this.restoreFailedTaskMutation(snapshot, options);
    }
    this.restoreDataSnapshot(snapshot?.data || snapshot);
    if (options.render !== false) this.render();
    return true;
  },

  async deleteTask(taskId) {
    const request = this.beginDialogRequest?.();
    const p = this.currentProject();
    const s = this.currentStage();
    const t = s?.tasks.find(x => x.id === taskId);
    if (!p || !s || !t) return;
    const executed = this.isTaskExecuted(t);
    const sampleIdsToRelease = this.isTaskCompleted(t) ? [] : [...(t.sampleIds || [])];
    if (typeof this.prepareTaskActionSamples === "function") {
      const preparation = this.prepareTaskActionSamples(t, sampleIdsToRelease, "删除任务");
      if (preparation?.then ? !await preparation : preparation === false) return;
    }
    if (this.isDialogRequestCurrent?.(request) === false) return;
    const detailsHtml = this.taskDeleteImpactHtml(p, s, t);
    this.confirmTaskDeleteKeyword(
      "删除任务",
      executed
        ? "该任务已经执行过，删除后会从任务管理中隐藏并归档，历史数据继续保留。"
        : "该任务尚未执行，删除后会从任务管理中物理移除。",
      async () => {
        const snapshot = this.taskActionMutationSnapshot();
        const completedBeforeArchive = this.isTaskCompleted(t);
        let archiveTransition = null;
        if (executed && !completedBeforeArchive) {
          archiveTransition = this.transitionTaskStatus(s, t, "异常终止", {
            issue: "任务被归档删除",
            completedAt: Utils.now(),
            endDate: Utils.today()
          });
        }
        // 已完成任务的样机去向已经由结束结果确定。归档历史任务不能把
        // “取走分析/已退库”等最终状态重新改成闲置，也不能清空取走人。
        if (!completedBeforeArchive) {
          this.releaseTaskSamples(t, {
            user: "管理员",
            source: executed ? "任务归档删除" : "任务删除",
            reason: executed ? "任务从任务管理中删除并归档" : "未执行任务被删除",
            projectId: p.id,
            stageId: s.id,
            forceLog: executed
          });
        }
        if (executed) {
          t.archived = true;
          t.deletedAt = Utils.now();
          this.addTaskLog(t, "任务归档删除", {
            user: "管理员",
            reason: "任务从任务管理中删除，样机履历保留",
            fromStatus: archiveTransition?.fromStatus || this.taskFlowStatus(t),
            toStatus: archiveTransition?.toStatus || this.taskFlowStatus(t)
          });
        } else {
          s.tasks = s.tasks.filter(x => x.id !== taskId);
        }
        const saved = await this.commitTaskMutation(p, s, t, {
          action: executed ? "archive_task_delete" : "delete_task",
          remark: executed ? "任务归档删除" : "未执行任务删除",
          user: "管理员",
          deleteMode: executed ? "" : "delete",
          sampleIdsForMutation: completedBeforeArchive ? [] : [...(t.sampleIds || [])]
        });
        if (!saved) {
          this.restoreFailedTaskActionMutation(snapshot);
          return false;
        }
        Utils.toast(executed ? "任务已归档隐藏，样机履历已保留。" : "任务已删除。");
        return false;
      },
      detailsHtml
    );
  },

  // 启动任务
  async startTask(projectId, stageId, taskId) {
    const request = this.beginDialogRequest?.();
    const { p, s, t } = this.getProjectStageTask(projectId, stageId, taskId);
    if (!t) return;
    if (this.isTaskCompleted(t)) { alert("任务已完成。"); return; }
    if (t.status === "进行中") { alert("任务已在进行中。"); return; }
    if (!(t.sampleIds || []).length) { alert("请先分配样机，再启动任务。"); return; }
    const isRestart = this.taskFlowStatus(t) === "阻塞中";
    if (!t.owner || !t.planStartDate || !t.planEndDate) {
      alert("请先在「设置计划」中填写执行人、计划开始时间和计划终止时间。");
      return;
    }
    const ownerCheck = this.validatePersonForScope(t.owner, "tester", "执行人", { project: p });
    if (!ownerCheck.ok) {
      alert(ownerCheck.msg || "执行人只能选择测试人员。请先修改计划。");
      return;
    }
    if (t.planStartDate > t.planEndDate) {
      alert("计划终止时间不能早于计划开始时间。请先修改计划。");
      return;
    }
    if (typeof this.prepareTaskActionSamples === "function") {
      const preparation = this.prepareTaskActionSamples(t, t.sampleIds || [], isRestart ? "恢复任务" : "启动任务");
      if (preparation?.then ? !await preparation : preparation === false) return;
    }
    if (this.isDialogRequestCurrent?.(request) === false) return;
    this.showConfirm(isRestart ? "恢复测试？" : "开始测试？", async () => {
      const mutationSnapshot = this.taskActionMutationSnapshot();
      const user = t.owner;
      const reason = isRestart ? "恢复测试" : "开始测试";
      const transition = this.transitionTaskStatus(s, t, "进行中", {
        owner: t.owner,
        startDate: (!isRestart || !t.startDate) ? Utils.today() : t.startDate,
        resetStartDate: !isRestart
      });
      (t.sampleIds || []).forEach(id => this.changeSampleStatus(id, "测试中", { user, source: isRestart ? "任务重启" : "任务启动", reason, projectId: p.id, stageId: s.id, taskId: t.id, testItem: t.testItem }));
      this.addTaskLog(t, isRestart ? "重启任务" : "启动任务", { user, reason, fromStatus: transition.fromStatus, toStatus: transition.toStatus });
      const saved = await this.commitTaskMutation(p, s, t, {
        action: isRestart ? "restart_task" : "start_task",
        remark: reason,
        user,
        sampleIdsForMutation: [...(t.sampleIds || [])]
      });
      if (!saved) this.restoreFailedTaskActionMutation(mutationSnapshot);
    }, {
      title: isRestart ? "恢复任务" : "启动任务",
      okText: isRestart ? "恢复测试" : "开始测试",
      okClass: "btn btn-pass"
    });
  },

  /**
   * 收集"本任务"范围内，每台样机被记录到的新增问题（按 sampleId 分组），返回 Map<sampleId, Set<description>>
   * 数据来源（去重）：
   *   - task.sampleFaultRecords[].problem
   *   - task.resultUploads[].samples[].problem 与 .problemRecords[]（taskId 命中本任务）
   *   - task.resultDraft.samples[].problem 与 .problemRecords[]（taskId 命中本任务）
   *   - 样机档案 problemRecords[]（taskId 命中本任务）
   */
  taskFailureProblemsBySample(project, stage, task) {
    const groups = new Map();
    if (!task) return groups;
    const belongsToTask = record => record.taskId === task.id;
    const add = (sampleId, text) => {
      const sid = String(sampleId || "").trim();
      const desc = String(text || "").trim();
      if (!sid || !desc) return;
      if (Utils.isNoSampleIssueText(desc)) return;
      if (!groups.has(sid)) groups.set(sid, new Set());
      groups.get(sid).add(desc);
    };
    (task.sampleFaultRecords || []).forEach(record => add(record.sampleId, record.problem));
    (task.resultUploads || []).forEach(upload => (upload.samples || []).forEach(item => {
      add(item.sampleId || item.sid, item.problem);
      (item.problemRecords || []).forEach(record => {
        if (belongsToTask(record)) add(item.sampleId || item.sid, record.description);
      });
    }));
    (task.resultDraft?.samples || []).forEach(item => {
      add(item.sampleId || item.sid, item.problem);
      (item.problemRecords || []).forEach(record => {
        if (belongsToTask(record)) add(item.sampleId || item.sid, record.description);
      });
    });
    this.taskResultSampleEntries(task).forEach(entry => {
      const found = this.findSample(entry.sampleId);
      this.sampleProblemRecords(found?.sample).forEach(record => {
        if (belongsToTask(record)) add(entry.sampleId, record.description);
      });
    });
    return groups;
  },

  /**
   * 基于"参与过本任务的全部样机"和"问题分组"计算失效统计：
   *   - active：当前仍在 task.sampleIds 中的样机（=正式完成测试的样机）
   *   - removed：在任务进行中被临时变更剔除的样机
   * 每台样机只要在本任务范围内有任何有效问题记录即记一次 F。
   */
  taskFailureStats(project, stage, task) {
    const problems = this.taskFailureProblemsBySample(project, stage, task);
    const entries = this.taskResultSampleEntries(task);
    let activeTotal = 0, activeFail = 0, removedTotal = 0, removedFail = 0;
    entries.forEach(e => {
      const hasProblem = (problems.get(e.sampleId)?.size || 0) > 0;
      if (e.state === "removed") {
        removedTotal++;
        if (hasProblem) removedFail++;
      } else {
        activeTotal++;
        if (hasProblem) activeFail++;
      }
    });
    return { activeTotal, activeFail, removedTotal, removedFail, problems, entries };
  },

  taskResultOutcomeStatus(task) {
    if (!task) return "";
    return this.taskResultStatus(task) || this.normalizeTaskResultValue(task.resultDraft?.result || "");
  },

  taskResultOutcomeLabel(resultStatus) {
    if (resultStatus === "通过") return "PASS";
    if (resultStatus === "不通过") return "FAIL";
    return "";
  },

  taskResultOutcomeBadgeHtml(task) {
    const flowStatus = this.taskFlowStatus(task);
    if (flowStatus === "进行中" || flowStatus === "阻塞中") {
      return '<span class="task-result-outcome is-doing" title="任务尚未完成">doing</span>';
    }
    const resultStatus = this.taskResultOutcomeStatus(task);
    const label = this.taskResultOutcomeLabel(resultStatus);
    if (!label) return "";
    const cls = resultStatus === "不通过" ? "is-fail" : "is-pass";
    return `<span class="task-result-outcome ${cls}" title="由测试结果“${Utils.esc(resultStatus)}”自动判定">${label}</span>`;
  },

  /**
   * 任务"测试结果"列摘要：
   *   行1 失效比例： {F}F/{N}  · 变更 {F}F/{N}（仅在临时变更过的样机存在时显示后半段）
   *   行2..n 失效样机问题清单：每台一行，"{档案号} ：问题1；问题2"，档案号可点击查看样机卡片
   * 无样机或未启动时显示 "-"。
   */
  /**
   * 拼接任务"测试结果"列可见的纯文本，用于关键词搜索。
   * 不产生 DOM/HTML，只返回纯文本字符串。
   */
  taskResultSearchText(project, stage, task) {
    if (!task) return "";
    const parts = [];
    const stats = this.taskFailureStats(project, stage, task);
    // DTS 单号
    if (task.issueRecord?.dtsNo) parts.push(task.issueRecord.dtsNo);
    // 问题确认说明
    if (task.issueRecord?.issueNote) parts.push(task.issueRecord.issueNote);
    const resultStatus = this.taskResultOutcomeStatus(task);
    const outcomeLabel = this.taskResultOutcomeLabel(resultStatus);
    if (resultStatus) parts.push(resultStatus);
    if (outcomeLabel) parts.push(outcomeLabel);
    // 失效比例统计文字
    if (stats.activeTotal > 0) {
      parts.push(`正式样机 ${stats.activeFail}F/${stats.activeTotal}`);
    }
    if (stats.removedTotal > 0) {
      parts.push(`变更样机 ${stats.removedFail}F/${stats.removedTotal}`);
    }
    // 失效样机的问题描述 + 样机编号
    this.taskResultSampleEntries(task).forEach(entry => {
      const set = stats.problems.get(entry.sampleId);
      if (!set || !set.size) return;
      const found = this.findSample(entry.sampleId);
      const snapshot = task.sampleSnapshots?.[entry.sampleId] || null;
      const code = found?.sample
        ? this.sampleDisplayCode(found.sample)
        : (snapshot?.code || snapshot?.sampleNo || entry.sampleId);
      parts.push(code);
      parts.push([...set].join("；"));
    });
    // 最后一次上传结果
    const lastUpload = (task.resultUploads || []).slice(-1)[0];
    if (lastUpload?.result) parts.push(lastUpload.result);
    return parts.filter(Boolean).join(" ").toLowerCase();
  },

  taskIssueSummaryHtml(project, stage, task) {
    if (!task) return "-";
    const flowStatus = this.taskFlowStatus(task);
    const stats = this.taskFailureStats(project, stage, task);
    const { activeTotal, activeFail, removedTotal, removedFail, problems } = stats;
    const resultStatus = this.taskResultOutcomeStatus(task);
    const outcomeHtml = this.taskResultOutcomeBadgeHtml(task);

    // 待下发且没录入过任何结果：保持 "-"
    if (flowStatus === "待下发" && !problems.size && !(task.resultUploads || []).length && !task.resultDraft && !resultStatus) {
      return `<span class="muted">-</span>`;
    }
    if (activeTotal === 0 && removedTotal === 0) {
      if (outcomeHtml) {
        return `<div class="task-result-summary">
          <div class="task-result-summary-ratio">${outcomeHtml}</div>
        </div>`;
      }
      return `<span class="muted">-</span>`;
    }

    const ratioCls = activeFail > 0 ? "task-result-ratio is-fail" : "task-result-ratio is-pass";
    const removedCls = removedFail > 0 ? "task-result-ratio-removed is-fail" : "task-result-ratio-removed";
    // 失效比例：正式样机 / 变更样机 两组，分别显示完整标签
    const ratioHtml = `<span class="${ratioCls}">正式样机 ${activeFail}F/${activeTotal}</span>`
      + (removedTotal > 0
        ? `<span class="task-result-ratio-sep">·</span><span class="${removedCls}">变更样机 ${removedFail}F/${removedTotal}</span>`
        : "");



    // 失效样机问题清单：按"先 active 后 removed"的顺序遍历
    const failLines = [];
    this.taskResultSampleEntries(task).forEach(entry => {
      const set = problems.get(entry.sampleId);
      if (!set || !set.size) return;
      const found = this.findSample(entry.sampleId);
      const snapshot = task.sampleSnapshots?.[entry.sampleId] || null;
      const code = found?.sample
        ? this.sampleDisplayCode(found.sample)
        : (snapshot?.code || snapshot?.sampleNo || entry.sampleId);
      const isDestroyedSnapshot = !found?.sample && !!snapshot?.destroyedAt;
      const codeHtml = entry.sampleId && !isDestroyedSnapshot
        ? `<button type="button" class="sample-log-link" data-app-action="sample-readonly" data-stop-propagation="1" data-id="${Utils.esc(entry.sampleId)}">${Utils.esc(code)}</button>`
        : `<span class="sample-log-ref-missing" title="样机档案不存在或已销毁">${Utils.esc(code)}</span>`;
      const removedTag = entry.state === "removed" ? `<span class="task-result-tag-removed">变更</span>` : "";
      const problemText = Utils.esc([...set].join("；"));
      failLines.push(`<div class="task-result-fail-line">${codeHtml}${removedTag}：${problemText}</div>`);
    });

    return `<div class="task-result-summary">
      <div class="task-result-summary-ratio">${outcomeHtml}${ratioHtml}</div>
      ${failLines.length ? `<div class="task-result-fail-list">${failLines.join("")}</div>` : ""}
    </div>`;
  },

  async tempChangeTask(projectId, stageId, taskId) {
    const request = this.beginDialogRequest?.();
    const { p, s, t } = this.getProjectStageTask(projectId, stageId, taskId);
    if (!p || !s || !t || this.isTaskCompleted(t)) return;
    if (typeof this.prepareTaskActionSamples === "function") {
      const preparation = this.prepareTaskActionSamples(t, t.sampleIds || [], "打开临时变更");
      if (preparation?.then ? !await preparation : preparation === false) return;
    }
    if (this.isDialogRequestCurrent?.(request) === false) return;
    const { progress } = this.resolveTaskProgress(s, t, t.progressId);
    const requiredSampleCount = this.getProgressRequiredSampleCount(s, progress);
    const sampleCards = this.buildTaskSamplePickerHtml(
      t.sampleIds || [],
      "tempSamplePick",
      "tempSampleProgress",
      "tempSampleLimitHint",
      t.id,
      {
        progressId: progress?.id || t.progressId || "",
        requiredSampleCount: requiredSampleCount ?? t.requiredSampleCount ?? null,
        planStartInputId: "tempPlanStart", planEndInputId: "tempPlanEnd", showScheduleHint: false
      }
    );
    const modalId = this.showModal("临时变更", `
      <div class="temp-change-header-row">
        <div class="form-group"><label class="req danger-field-label">任务变更人</label>${this.projectMemberSelectHtml("tempUser", "", "请选择任务变更人", { scope: "tester" })}</div>
        <div class="form-group"><label>变更原因</label><textarea id="tempReason" rows="1" class="temp-reason-one-line" placeholder="选填"></textarea></div>
      </div>
      <div class="temp-change-plan-row">
        <div class="form-group"><label class="req">执行人变更</label>${this.projectMemberSelectHtml("tempOwner", t.owner || "", "请选择执行人", { scope: "tester" })}</div>
        <div class="form-group"><label>计划开始</label><input type="date" id="tempPlanStart" data-app-action="task-sample-picker-schedule" data-app-events="change" data-id="tempSamplePick" value="${Utils.esc(t.planStartDate || t.planDate || "")}"></div>
        <div class="form-group"><label>计划完成</label><input type="date" id="tempPlanEnd" data-app-action="task-sample-picker-schedule" data-app-events="change" data-id="tempSamplePick" value="${Utils.esc(t.planEndDate || t.endDate || "")}"></div>
      </div>
      <section class="temp-change-device-section">
        <h3>测试设备变更</h3>
        <p class="path">可替换或移除故障设备。阻塞中的任务在保存后仍保持阻塞，确认设备可用后再手动恢复测试。</p>
        ${this.taskDeviceConfigPanelHtml?.(t) || ""}
      </section>
      <div class="temp-change-sample-section">
        <input type="hidden" id="tempSampleProgress" value="${Utils.esc(progress?.id || t.progressId || "")}">
        <div class="form-group task-sample-config-group">
          <div class="task-sample-label-row task-sample-label-row-compact">
            <label>样机逐台变更</label>
            <div id="tempSampleLimitHint" class="sample-limit-hint sample-limit-global" title="当前已选 / 任务要求样机数"></div>
            ${this.taskSampleScheduleHintHtml()}
          </div>
          <div class="dispatch-sample-select">${sampleCards}</div>
        </div>
      </div>
    `, async () => {
      const { p, s, t } = this.getProjectStageTask(projectId, stageId, taskId);
      if (!t || this.isTaskCompleted(t)) { alert("任务状态已变化，请关闭后刷新。"); return true; }
      const { progress } = this.resolveTaskProgress(s, t, t.progressId);
      const user = document.getElementById("tempUser").value.trim();
      const owner = document.getElementById("tempOwner").value.trim();
      const reason = document.getElementById("tempReason").value.trim();
      const planStart = document.getElementById("tempPlanStart").value;
      const planEnd = document.getElementById("tempPlanEnd").value;
      const newSampleIds = this.getSelectedTaskSampleIds("tempSamplePick");
      const newDeviceIds = this.getSelectedTaskDeviceIds?.() || [...(t.deviceIds || [])];
      this.clearFieldValidationMarks();
      const userCheck = this.validatePersonForScope(user, "tester", "任务变更人");
      if (!userCheck.ok) { this.markFieldInvalid(document.getElementById("tempUser"), userCheck.msg); return true; }
      const ownerCheck = this.validatePersonForScope(owner, "tester", "执行人");
      if (!ownerCheck.ok) { this.markFieldInvalid(document.getElementById("tempOwner"), ownerCheck.msg); return true; }
      const changeReason = reason || "临时变更";
      if (!planStart || !planEnd || planStart > planEnd) {
        this.markFieldInvalid(document.getElementById("tempPlanEnd"), "请填写完整的计划时间，完成日期不能早于开始日期");
        return true;
      }
      if (progress) {
        const check = this.validateTaskSampleSelection(progress, newSampleIds, "临时变更");
        if (!check.ok) {
          const sampleArea = document.querySelector(".dispatch-sample-select");
          this.markFieldInvalid(sampleArea, check.msg);
          return true;
        }
      }

      // 保存旧值，供差异判断和日志使用
      const beforeOwner = String(t.owner || "").trim();
      const beforePlanStart = String(t.planStartDate || t.planDate || "").trim();
      const beforePlanEnd = String(t.planEndDate || t.endDate || "").trim();
      const beforeSampleIds = [...(t.sampleIds || [])];
      const beforeDeviceIds = [...(t.deviceIds || [])];
      const beforeStatus = this.taskFlowStatus(t);

      const afterOwner = String(owner || "").trim();
      const afterPlanStart = String(planStart || "").trim();
      const afterPlanEnd = String(planEnd || "").trim();
      const afterSampleIds = newSampleIds;

      const ownerChanged = beforeOwner !== afterOwner;
      const planStartChanged = beforePlanStart !== afterPlanStart;
      const planEndChanged = beforePlanEnd !== afterPlanEnd;
      const removed = beforeSampleIds.filter(id => !afterSampleIds.includes(id));
      const added = afterSampleIds.filter(id => !beforeSampleIds.includes(id));
      const sampleChanged = removed.length > 0 || added.length > 0;
      const deviceChanged = JSON.stringify(beforeDeviceIds.slice().sort()) !== JSON.stringify(newDeviceIds.slice().sort());

      if (!ownerChanged && !planStartChanged && !planEndChanged && !sampleChanged && !deviceChanged) {
        Utils.toast("未检测到变更");
        return false;
      }

      const epoch = this._dataSnapshotEpoch || 0;
      if (typeof this.prepareTaskActionSamples === "function"
        && !await this.prepareTaskActionSamples(t, [...new Set([...beforeSampleIds, ...afterSampleIds])], "保存临时变更")) return true;
      const current = this.getProjectStageTask(projectId, stageId, taskId);
      if ((this._dataSnapshotEpoch || 0) !== epoch || current.p !== p || current.s !== s || current.t !== t
        || this.isTaskCompleted(t)) return true;

      const mutationSnapshot = this.taskActionMutationSnapshot();
      // 写入新值
      t.owner = afterOwner;
      t.planStartDate = afterPlanStart;
      t.planEndDate = afterPlanEnd;
      t.planDate = afterPlanStart || t.planDate || "";
      t.sampleIds = afterSampleIds;
      t.deviceIds = newDeviceIds;

      // 只有样机变了才记录退出/新增和更新样机状态
      if (sampleChanged) {
        this.recordTaskRemovedSamples(t, removed, { user, reason, receiver: owner });
        removed.forEach(id => {
          if (!this.isSampleUsedByAnotherOpenTask(id, t.id)) {
            const found = this.findSample(id);
            this.changeSampleStatus(id, "闲置", {
              user,
              receiver: found?.sample?.owner || owner,
              source: "任务临时变更",
              reason: "从当前任务移除；" + changeReason,
              projectId: p.id,
              stageId: s.id,
              taskId: t.id,
              testItem: t.testItem
            });
          }
        });
        added.forEach(id => this.changeSampleStatus(id, this.statusForOpenTaskUsage(t), {
          user,
          receiver: owner,
          source: "任务临时变更",
          reason: "加入当前任务；" + changeReason,
          projectId: p.id,
          stageId: s.id,
          taskId: t.id,
          testItem: t.testItem
        }));
      }

      // 生成差异日志（只记录真实变化项）
      const afterStatus = this.taskFlowStatus(t);
      const sampleName = (id) => this.sampleDisplayCode(this.findSample(id)?.sample) || id;
      const removedNames = removed.map(sampleName);
      const addedNames = added.map(sampleName);
      const detailParts = [];
      if (ownerChanged) {
        detailParts.push(`任务执行人：${beforeOwner || "-"} → ${afterOwner || "-"}`);
      }
      if (planStartChanged) {
        detailParts.push(`计划开始：${beforePlanStart || "待设置"} → ${afterPlanStart || "待设置"}`);
      }
      if (planEndChanged) {
        detailParts.push(`计划终止：${beforePlanEnd || "待设置"} → ${afterPlanEnd || "待设置"}`);
      }
      // 样机变更：按退出→新增逐对展示
      const maxPairs = Math.max(removedNames.length, addedNames.length);
      for (let i = 0; i < maxPairs; i++) {
        const out = removedNames[i] || "-";
        const inn = addedNames[i] || "-";
        detailParts.push(`样机变更：${out} → ${inn}`);
      }
      // Equipment assignment logs and snapshots are authored by the server.
      if (detailParts.length) this.addTaskLog(t, "临时变更", {
          user,
          reason: changeReason,
          fromStatus: beforeStatus,
          toStatus: afterStatus,
          detail: detailParts.join("；"),
          detailLines: detailParts
        });

      const saved = await this.commitTaskMutation(p, s, t, {
        action: "temp_change_task",
        remark: changeReason,
        user,
        sampleIdsForMutation: sampleChanged ? [...new Set([...beforeSampleIds, ...afterSampleIds])] : []
      });
      if (!saved) {
        this.restoreFailedTaskActionMutation(mutationSnapshot, { render: false });
        this.refreshTaskDevicePicker?.();
        return true;
      }
      return false;
    }, "确认", { className: "temp-change-modal", headerHint: `任务：${Utils.esc(t.testItem || "-")}` });
    setTimeout(() => {
      if (modalId != null && this._currentModalId !== modalId) return;
      this.initTaskSamplePicker("tempSamplePick");
      this.updateTaskSampleLimitUI("tempSampleProgress", "tempSamplePick", "tempSampleLimitHint");
      this.refreshTaskDevicePicker?.();
    }, 0);
  },

  // 阻塞任务
  async blockTask(projectId, stageId, taskId) {
    const request = this.beginDialogRequest?.();
    const { p, s, t } = this.getProjectStageTask(projectId, stageId, taskId);
    if (!t || this.isTaskCompleted(t)) return;
    if (this.taskFlowStatus(t) === "阻塞中") { alert("任务已是阻塞状态。"); return; }
    if (typeof this.prepareTaskActionSamples === "function") {
      const preparation = this.prepareTaskActionSamples(t, t.sampleIds || [], "阻塞任务");
      if (preparation?.then ? !await preparation : preparation === false) return;
    }

    if (this.isDialogRequestCurrent?.(request) === false) return;
    this.showModal("阻塞暂停", `
      <div class="task-block-task-title">任务：${Utils.esc(t.testItem || "-")}</div>
      <div class="task-block-task-desc">阻塞只记录任务无法继续；样机失效请点击“结果”录入，结束任务并同步后写入档案。</div>
      <div class="form-group"><label class="req">状态变更人</label>${this.projectMemberSelectHtml("user", "", "请选择状态变更人", { scope: "tester" })}</div>
      <div class="form-group"><label class="req">阻塞原因说明</label><textarea id="reason" rows="3" placeholder="必须填写，如：设备故障暂停"></textarea></div>
    `, async () => {
      const { p, s, t } = this.getProjectStageTask(projectId, stageId, taskId);
      if (!t || this.isTaskCompleted(t)) { alert("任务状态已变化，请关闭后刷新。"); return true; }
      this.clearFieldValidationMarks();
      const user = document.getElementById("user").value.trim();
      const reason = document.getElementById("reason").value.trim();
      const userCheck = this.validatePersonForScope(user, "tester", "状态变更人");
      if (!userCheck.ok) { this.markFieldInvalid(document.getElementById("user"), userCheck.msg); return true; }
      if (!reason) { this.markFieldInvalid(document.getElementById("reason"), "必须填写阻塞原因"); return true; }
      const mutationSnapshot = this.taskActionMutationSnapshot();
      const transition = this.transitionTaskStatus(s, t, "阻塞中", { reason, issue: reason });
      (t.sampleIds || []).forEach(id => this.changeSampleStatus(id, "在位等待", { user, source: "任务阻塞", reason, projectId: p.id, stageId: s.id, taskId: t.id, testItem: t.testItem }));
      this.addTaskLog(t, "阻塞任务", { user, reason, fromStatus: transition.fromStatus, toStatus: transition.toStatus });
      const saved = await this.commitTaskMutation(p, s, t, {
        action: "block_task",
        remark: reason,
        user,
        sampleIdsForMutation: [...(t.sampleIds || [])]
      });
      if (!saved) {
        this.restoreFailedTaskActionMutation(mutationSnapshot, { render: false });
        return true;
      }
      return false;
    }, "确认", { className: "task-block-modal" });
  },

});
