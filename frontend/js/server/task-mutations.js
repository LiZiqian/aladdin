/* 任务载荷构建与单条/批量提交。先克隆编辑载荷，再排队；拿到写入槽位后更新 revision；finally 必须释放槽位。
 * 依赖 app.core.js 注册器；index.html 在 app.init() 前按顺序加载。
 * 维护说明：docs/architecture.md。
 */
app.registerModule("server.task-mutations", {

  taskMutationSampleIds(task) {
    const ids = new Set();
    const add = value => {
      const id = String(value || "").trim();
      if (id) ids.add(id);
    };
    (task?.sampleIds || []).forEach(add);
    (task?.removedSampleRecords || []).forEach(item => add(item?.sampleId || item?.sid));
    (task?.sampleFaultRecords || []).forEach(item => add(item?.sampleId || item?.sid));
    (task?.resultDraft?.samples || []).forEach(item => add(item?.sampleId || item?.sid));
    (task?.resultUploads || []).forEach(upload => (upload?.samples || []).forEach(item => add(item?.sampleId || item?.sid)));
    return [...ids];
  },

  compactStageForMutation(stage) {
    if (!stage) return null;
    const copy = { ...stage };
    delete copy.tasks;
    delete copy.usedSampleRuns;
    delete copy.runningSampleCount;
    delete copy.progressTaskCounts;
    return copy;
  },

  compactProjectForMutation(project) {
    if (!project) return null;
    const copy = { ...project };
    delete copy.stages;
    delete copy.samplePersonCounts;
    return copy;
  },

  compactSampleForMutation(sample) {
    if (!sample) return null;
    const copy = { ...sample };
    delete copy.testedItemNames;
    delete copy.testHistoryCount;
    delete copy.photos;
    delete copy.logs;
    return copy;
  },

  compactSampleCategoryForMutation(category) {
    if (!category) return null;
    const copy = { ...category };
    delete copy.samples;
    return copy;
  },

  sampleEventsForTaskMutation(task, sampleIds = []) {
    const sampleSet = new Set((sampleIds || []).map(id => String(id || "")).filter(Boolean));
    if (!sampleSet.size) return [];
    return (this.data?.sampleLibrary?.logs || []).filter(log => {
      if (!log) return false;
      return sampleSet.has(String(log.sampleId || ""));
    });
  },

  taskSampleStatusBlockerMessage(json = {}) {
    return (json.samples || []).slice(0, 8).map(item => {
      const found = this.findSample?.(item.sampleId);
      const sampleName = found?.sample?.sampleNo || item.sampleNo || found?.sample?.sn || item.sn || item.imei || item.sampleId;
      const status = item.status || "未知状态";
      const taskNames = (item.tasks || []).map(t => t.testItem || t.taskId || "未命名任务").join("、");
      return `· 样机 ${sampleName}：当前状态「${status}」${taskNames ? `，目标任务「${taskNames}」` : ""}`;
    }).join("\n");
  },

  handleTaskDeviceMutationFailure(json = {}) {
    if (!["TASK_DEVICE_IDS_INVALID", "TASK_DEVICE_ASSIGNMENT_NOT_ALLOWED", "DEVICE_NOT_AVAILABLE", "DEVICE_OCCUPANCY_CONFLICT"].includes(json.error_code)) return false;
    this._lastTaskMutationError = json;
    this.invalidateDeviceWarehouse?.();
    const details = (json.devices || json.conflicts || []).slice(0, 8).map(item => {
      const name = item.device?.name || item.deviceId || "设备";
      const code = item.device?.code ? `（${item.device.code}）` : "";
      const task = item.testItem ? ` · ${item.testItem}` : "";
      const dates = item.planStartDate || item.planEndDate ? `（${item.planStartDate || "未设置"} ~ ${item.planEndDate || "未设置"}）` : "";
      return `· ${name}${code}${task}${dates}：${item.reason || "不可用"}`;
    }).join("\n");
    this.updateServerStatus("设备配置未保存");
    alert(`${json.error || "设备当前不可用于此任务"}${details ? "\n\n" + details : ""}`);
    return true;
  },

  async commitTaskMutation(project, stage, task, { action = "task_mutation", remark = "任务增量变更", user = "", render = true, createIfMissing = false, deleteMode = "", sampleIdsForMutation = null } = {}) {
    if (!project || !stage || !task) return false;
    this._lastTaskMutationError = null;
    const sampleIds = this.taskMutationSampleIds(task);
    this.ensureTaskSampleSnapshots?.(task, sampleIds);
    const mutationSampleIds = Array.isArray(sampleIdsForMutation)
      ? [...new Set(sampleIdsForMutation.map(id => String(id || "").trim()).filter(Boolean))]
      : sampleIds;
    const samples = mutationSampleIds
      .map(id => this.compactSampleForMutation(this.findSample(id)?.sample))
      .filter(Boolean);
    const payload = this.cloneData({
      revision: this.serverRevision,
      projectId: project.id,
      stageId: stage.id,
      taskId: task.id,
      action,
      remark,
      user,
      stage: this.compactStageForMutation(stage),
      task,
      samples,
      sampleEvents: this.sampleEventsForTaskMutation(task, mutationSampleIds),
      createIfMissing,
      deleteMode,
    });
    const release = await this.beginServerMutation();
    if (!release) return false;
    payload.revision = this.serverRevision;
    this.updateServerStatus("同步中");
    try {
      const resp = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/mutation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await resp.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
      if (!json.ok && this.handleTaskDeviceMutationFailure(json)) return false;
      if (resp.status === 409 && json.error_code === "SAMPLE_OCCUPANCY_CONFLICT") {
        this._lastTaskMutationError = json;
        const detail = (json.conflicts || []).slice(0, 5).map(c => {
          const sample = this.findSample?.(c.sampleId);
          const sampleName = sample?.sample?.sampleNo || sample?.sample?.sn || c.sampleId;
          const items = (c.tasks || []).map(t => `${t.testItem || "未命名任务"}（${t.planStartDate || "未设置"} ~ ${t.planEndDate || "未设置"}）${t.reason ? '：' + t.reason : ''}`).join("；");
          return `· 样机 ${sampleName}：${items}`;
        }).join("\n");
        this.updateServerStatus("样机占用冲突");
        alert(`保存被拒绝：样机预约或执行冲突。\n\n可调整计划日期，或先结束/释放实际占用的任务：\n${detail}`);
        return false;
      }
      if (resp.status === 409 && json.error_code === "SAMPLE_CURRENT_STATE_LOCKED") {
        this._lastTaskMutationError = json;
        const detail = (json.conflicts || []).slice(0, 5).map(c => {
          const sample = this.findSample?.(c.sampleId);
          const sampleName = sample?.sample?.sampleNo || sample?.sample?.sn || c.sampleId;
          const items = (c.tasks || []).map(t => t.testItem || t.taskId || "未命名任务").join("、");
          return `· 样机 ${sampleName}：正在「${items}」中使用`;
        }).join("\n");
        this.updateServerStatus("样机当前信息已锁定");
        alert(`保存被拒绝：样机正在其他未完成任务中，不能通过已完成任务覆盖当前信息。\n${detail}`);
        return false;
      }
      if (resp.status === 409 && json.error_code === "SAMPLE_STATUS_NOT_SELECTABLE") {
        this._lastTaskMutationError = json;
        this.updateServerStatus("样机状态不可选");
        alert(`保存被拒绝：样机当前状态不可用于测试。\n\n请确认样机已归还且可用：\n${this.taskSampleStatusBlockerMessage(json)}`);
        return false;
      }
      if (resp.status === 409 && json.error_code === "TASK_ALREADY_FINISHED") {
        this._lastTaskMutationError = json;
        this.updateServerStatus("任务已结束");
        Utils.toast("任务已经结束，已同步服务器状态。");
        return false;
      }
      if (resp.status === 409 && json.error_code === "TASK_STATE_CONFLICT") {
        this._lastTaskMutationError = json;
        this.updateServerStatus("任务状态已变化");
        alert(`操作已取消：任务当前状态已变为「${json.taskStatus || "未知"}」。\n\n平台将刷新最新任务和样机状态，请重新确认后再操作。`);
        json._refreshSucceeded = await this.refreshAfterTaskStateConflict(project.id, stage.id);
        return false;
      }
      if (resp.status === 409 && json.error_code === "TASK_REVISION_CONFLICT") {
        this._lastTaskMutationError = json;
        this.updateServerStatus("页面数据已过期");
        alert("操作已取消：平台数据已被其他页面更新。\n\n为避免旧页面覆盖新数据，平台将刷新当前项目；请核对最新任务和样机状态后重新操作。");
        json._refreshSucceeded = await this.refreshAfterMutationRevisionConflict();
        return false;
      }
      if (!resp.ok || !json.ok) throw new Error(json.error || ("HTTP " + resp.status));
      this.acceptMutationResult(payload, json);
      this.invalidateSampleHistoryCache(mutationSampleIds);
      await this.refreshTaskListAfterMutation(project, stage, { render, affected: json.affected });
      this.updateServerStatus("已保存");
      return true;
    } catch (e) {
      console.error("任务增量保存失败：", e);
      this.updateServerStatus("保存失败");
      alert("任务增量保存失败：" + e.message);
      return false;
    } finally {
      release();
    }
  },

  async commitTaskBatchMutation(project, stage, tasks, { action = "task_batch_mutation", remark = "批量任务增量变更", user = "", render = true, createIfMissing = true } = {}) {
    if (!project || !stage || !Array.isArray(tasks) || !tasks.length) return false;
    tasks.forEach(task => this.ensureTaskSampleSnapshots?.(task, this.taskMutationSampleIds(task)));
    const payload = this.cloneData({
      revision: this.serverRevision,
      projectId: project.id,
      stageId: stage.id,
      action,
      remark,
      user,
      stage: this.compactStageForMutation(stage),
      tasks,
      createIfMissing,
    });
    const release = await this.beginServerMutation();
    if (!release) return false;
    payload.revision = this.serverRevision;
    this.updateServerStatus("同步中");
    try {
      const resp = await fetch(`/api/stages/${encodeURIComponent(stage.id)}/tasks/batch`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await resp.json().catch(() => ({ ok: false, error: "服务器返回不是 JSON" }));
      if (!json.ok && this.handleTaskDeviceMutationFailure(json)) return false;
      if (resp.status === 409 && json.error_code === "TASK_REVISION_CONFLICT") {
        this._lastTaskMutationError = json;
        alert("批量任务未保存：平台数据已被其他页面更新。将读取最新数据，请核对后重新操作。");
        json._refreshSucceeded = await this.refreshAfterMutationRevisionConflict();
        return false;
      }
      if (resp.status === 409 && json.error_code === "SAMPLE_STATUS_NOT_SELECTABLE") {
        this.updateServerStatus("样机状态不可选");
        alert(`保存被拒绝：样机状态不可选。\n\n只有「闲置」样机可以加入测试任务：\n${this.taskSampleStatusBlockerMessage(json)}`);
        return false;
      }
      if (!resp.ok || !json.ok) throw new Error(json.error || ("HTTP " + resp.status));
      this.acceptMutationResult(payload, json);
      this.invalidateSampleHistoryCache([...new Set(tasks.flatMap(task => this.taskMutationSampleIds(task)))]);
      await this.refreshTaskListAfterMutation(project, stage, { render, affected: json.affected });
      this.updateServerStatus("已保存");
      return true;
    } catch (e) {
      console.error("批量任务增量保存失败：", e);
      this.updateServerStatus("保存失败");
      alert("批量任务增量保存失败：" + e.message);
      return false;
    } finally {
      release();
    }
  },

  taskMutationPayloadFor(project, stage, task, { createIfMissing = false } = {}) {
    this.ensureTaskSampleSnapshots?.(task, this.taskMutationSampleIds(task));
    return {
      projectId: project?.id,
      stageId: stage?.id,
      taskId: task?.id,
      stage: this.compactStageForMutation(stage),
      task,
      createIfMissing
    };
  },

});
