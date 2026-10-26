/* 将服务器受影响记录合并到本地，以及写入冲突后的刷新/回滚。revision 是平台版本，epoch 是整份快照替换代次。
 * 依赖 app.core.js 注册器；index.html 在 app.init() 前按顺序加载。
 * 维护说明：docs/architecture.md。
 */
app.registerModule("server.mutation-results", {

  // Server acknowledgement is applied synchronously before any page refresh.
  // Keep revision monotonic and acknowledge only this payload, not all edits.
  acceptMutationResult(payload, json) {
    this.serverRevision = Math.max(Number(this.serverRevision) || 0, Number(json.revision) || 0);
    this.serverUpdatedAt = json.updated_at || new Date().toISOString();
    this.serverOnline = true;
    this.applyMutationAffected(json.affected);
    this.syncMutationPayloadBaseline(payload, json.affected);
  },

  mergeProjectSummaryRows(projects = []) {
    if (!Array.isArray(this.data.projects)) this.data.projects = [];
    const byId = new Map(this.data.projects.map(project => [String(project.id || ""), project]));
    (projects || []).forEach(summary => {
      const id = String(summary?.id || "");
      if (!id) return;
      const existing = byId.get(id);
      if (existing) {
        Object.assign(existing, summary, {
          stages: Array.isArray(existing.stages) ? existing.stages : [],
          _summaryOnly: !existing._detailLoaded,
        });
      } else {
        const created = { ...summary, stages: [], _summaryOnly: true, _detailLoaded: false };
        this.data.projects.push(created);
        byId.set(id, created);
      }
    });
    return this.data.projects;
  },

  mergeSampleCategorySummaryRows(categories = []) {
    if (!this.data.sampleLibrary) this.data.sampleLibrary = { categories: [], logs: [] };
    if (!Array.isArray(this.data.sampleLibrary.categories)) this.data.sampleLibrary.categories = [];
    const byId = new Map(this.data.sampleLibrary.categories.map(category => [String(category.id || ""), category]));
    (categories || []).forEach(summary => {
      const id = String(summary?.id || "");
      if (!id) return;
      const existing = byId.get(id);
      if (existing) {
        Object.assign(existing, summary, {
          samples: Array.isArray(existing.samples) ? existing.samples : [],
          _summaryOnly: !existing.samplesLoaded,
        });
      } else {
        const created = { ...summary, samples: [], _summaryOnly: true, samplesLoaded: false };
        this.data.sampleLibrary.categories.push(created);
        byId.set(id, created);
      }
    });
    return this.data.sampleLibrary.categories;
  },

  applyMutationAffected(affected = {}) {
    if (!affected || typeof affected !== "object") return false;
    // Equipment usage is derived from tasks, including deletion and parent deletion.
    // Invalidate in-flight reads so an older response cannot restore a stale card.
    this.invalidateDeviceWarehouse?.();
    const changes = { taskStatus: [], sampleStatus: [], samplePerson: [] };
    this.mergeProjectSummaryRows(affected.projectSummaries || []);
    this.mergeSampleCategorySummaryRows(affected.sampleCategorySummaries || []);
    (affected.stageSummaries || []).forEach(summary => {
      (this.data.projects || []).forEach(project => {
        const stage = (project.stages || []).find(stage => stage.id === summary.id);
        if (stage) Object.assign(stage, this.cloneData(summary));
      });
    });
    if (affected.samplePersonCounts) {
      (this.data.projects || []).forEach(project => {
        if (project._detailLoaded || project.samplePersonCounts) project.samplePersonCounts = this.cloneData(affected.samplePersonCounts);
      });
    }

    (affected.tasks || []).forEach(task => {
      const project = (this.data.projects || []).find(item => String(item.id || "") === String(task?.projectId || ""));
      const stage = (project?.stages || []).find(item => String(item.id || "") === String(task?.stageId || ""));
      if (!stage) return;
      if (!Array.isArray(stage.tasks)) stage.tasks = [];
      const existing = stage.tasks.find(item => String(item.id || "") === String(task.id || ""));
      const baseline = (this._baseData?.projects || []).find(item => item.id === project.id)
        ?.stages?.find(item => item.id === stage.id)?.tasks?.find(item => item.id === task.id);
      const beforeStatus = typeof this.taskFlowStatus === "function" && (baseline || existing)
        ? this.taskFlowStatus(baseline || existing) : "";
      if (existing) Object.assign(existing, task);
      else stage.tasks.push(task);
      const merged = existing || task;
      const afterStatus = typeof this.taskFlowStatus === "function" ? this.taskFlowStatus(merged) : "";
      if (beforeStatus || afterStatus) {
        changes.taskStatus.push({
          projectId: task.projectId || project.id || "",
          stageId: task.stageId || stage.id || "",
          taskId: task.id || "",
          beforeStatus,
          afterStatus,
        });
      }
    });

    (affected.samples || []).forEach(sample => {
      const category = (this.data.sampleLibrary?.categories || []).find(item => String(item.id || "") === String(sample?.categoryId || ""));
      if (!category) return;
      if (!Array.isArray(category.samples)) category.samples = [];
      const existing = category.samples.find(item => String(item.id || "") === String(sample.id || ""));
      const baseline = (this._baseData?.sampleLibrary?.categories || []).find(item => item.id === category.id)
        ?.samples?.find(item => item.id === sample.id);
      const beforeSample = baseline || existing;
      if (beforeSample && ["owner", "borrower"].some(field =>
        Object.prototype.hasOwnProperty.call(sample, field)
        && String(beforeSample[field] || "") !== String(sample[field] || ""))) {
        changes.samplePerson.push({ categoryId: category.id, sampleId: sample.id });
      }
      const beforeStatus = existing && typeof this.sampleEffectiveStatus === "function" ? this.sampleEffectiveStatus(existing) : "";
      if (existing) Object.assign(existing, sample);
      else category.samples.push(sample);
      const merged = existing || sample;
      const afterStatus = typeof this.sampleEffectiveStatus === "function" ? this.sampleEffectiveStatus(merged) : "";
      if (beforeStatus || afterStatus) {
        changes.sampleStatus.push({
          categoryId: sample.categoryId || category.id || "",
          sampleId: sample.id || "",
          beforeStatus,
          afterStatus,
        });
      }
    });
    this._lastMutationAffectedChanges = changes;
    return true;
  },

  async refreshAfterMutationRevisionConflict() {
    try {
      const bootstrap = await this.fetchBootstrapState();
      // Discard snapshots and in-flight reads from the rejected revision together.
      this._dataSnapshotEpoch = (this._dataSnapshotEpoch || 0) + 1;
      clearTimeout(this._stageStrategySaveTimer);
      clearTimeout(this._strategySyncTimer);
        this._stageStrategySaveTimer = this._strategySyncTimer = null;
      this._projectDetailPromises = {};
      this._sampleCategoryDetailPromises = {};
      this._sampleLookupPromises = {};
      this._sampleDetailPromises = {};
      this._sampleHistoryRequests = {};
      this._sampleHistoryCache = {};
      this.data = bootstrap.data || this.emptyData();
      this.serverRevision = bootstrap.revision || 0;
      this.serverUpdatedAt = bootstrap.updated_at || null;
      this.serverOnline = true;
      this._statePartial = bootstrap.partial !== false;
      this.normalize();
      this._baseData = this.cloneData(this.data);
      if (!(this.data.projects || []).some(project => project.id === this.view?.selectedProjectId)) {
        this.view.selectedProjectId = this.data.projects?.[0]?.id || null;
        this.view.selectedStageId = null;
      }
      this.view.stageStrategyId = null;
      this.invalidatePagedCaches();
      if (Array.isArray(this._modalStack)) this._modalStack.length = 0;
      this.closeModal?.(this._currentModalId);
      this.closeConfirm?.();
      this.render();
      this.updateServerStatus("已刷新，请重新确认修改");
      return true;
    } catch (e) {
      console.error("版本冲突后刷新失败：", e);
      this.updateServerStatus("刷新失败");
      alert("平台数据已更新，自动刷新失败。请保留需要重新填写的内容后刷新页面：" + e.message);
      return false;
    }
  },

  async handleMutationRevisionConflict(response, json) {
    if (response.status !== 409 || json.error_code !== "MUTATION_REVISION_CONFLICT") return false;
    this.updateServerStatus("页面数据已过期");
    alert("本次修改未保存：平台数据已被其他页面更新。\n\n将重新读取最新数据，请核对后重新操作，避免旧内容覆盖新数据。");
    await this.refreshAfterMutationRevisionConflict();
    return true;
  },

  async refreshAfterTaskStateConflict() {
    return this.refreshAfterMutationRevisionConflict();
  },

  taskMutationSnapshot() {
    return {
      data: this.dataSnapshot(),
      baseData: this.cloneData(this._baseData || this.dataSnapshot())
    };
  },

  restoreFailedTaskMutation(snapshot, { render = true } = {}) {
    if (!snapshot) return false;
    if (this.isDataSnapshotCurrent?.(snapshot.data) === false) return false;
    const stateConflictWasRefreshed = ["TASK_STATE_CONFLICT", "TASK_REVISION_CONFLICT"].includes(this._lastTaskMutationError?.error_code)
      && this._lastTaskMutationError?._refreshSucceeded === true;
    if (stateConflictWasRefreshed) return false;
    this.restoreDataSnapshot(snapshot.data);
    this._baseData = this.cloneData(snapshot.baseData || snapshot.data);
    this.invalidatePagedCaches();
    if (render) this.render();
    return true;
  },

});
