/* 数据包预览/提交与导入结果合并。仅应用服务端确认的受影响范围；不得用局部摘要替代完整基线。
 * 依赖 app.core.js 注册器；index.html 在 app.init() 前按顺序加载。
 * 维护说明：docs/architecture.md。
 */
app.registerModule("server.transfer", {

  importMutationIdSets(mutationSummary = {}) {
    const toSet = values => new Set((values || []).map(value => String(value || "")).filter(Boolean));
    return {
      projectIds: toSet(mutationSummary.projectIds),
      stageIds: toSet(mutationSummary.stageIds),
      sampleCategoryIds: toSet(mutationSummary.sampleCategoryIds),
      sampleIds: toSet(mutationSummary.sampleIds),
    };
  },

  async applyImportBundleMutationResult(result = {}, { render = true } = {}) {
    this.invalidateDeviceWarehouse?.();
    const mutationSummary = result.mutationSummary || null;
    this.serverRevision = Math.max(Number(this.serverRevision) || 0, Number(result.revision || result.newRevision) || 0);
    this.serverUpdatedAt = result.updated_at || result.updatedAt || new Date().toISOString();
    this.serverOnline = true;

    if (!mutationSummary || mutationSummary.requiresFullState) {
      console.error("导入提交缺少局部同步摘要，拒绝自动拉取完整 state。");
      this.updateServerStatus("导入已写入，同步失败");
      return false;
    }

    this.updateServerStatus("同步导入");
    this.invalidatePagedCaches();
    const { projectIds, stageIds, sampleCategoryIds } = this.importMutationIdSets(mutationSummary);

    try {
      const hydration = await this.readCurrentServerData(async () => {
        const [projectSummaries, categorySummaries, details] = await Promise.all([
          this.fetchProjectSummary(),
          this.fetchSampleCategoriesSummary(),
          Promise.all([...projectIds].map(id => this.fetchProjectDetail(id, { includeTasks: false }))),
        ]);
        return { projectSummaries, categorySummaries, details };
      }, undefined, hydration => {
        const projectDraft = hydration.projectSummaries.some(summary => this.serverReadHasLocalEdits(
          this.compactProjectForMutation((this.data.projects || []).find(project => project.id === summary.id)),
          this.compactProjectForMutation((this._baseData?.projects || []).find(project => project.id === summary.id))));
        const categoryDraft = hydration.categorySummaries.some(summary => this.serverReadHasLocalEdits(
          this.compactSampleCategoryForMutation(this.data.sampleLibrary.categories.find(category => category.id === summary.id)),
          this.compactSampleCategoryForMutation(this._baseData?.sampleLibrary?.categories?.find(category => category.id === summary.id))));
        const detailDraft = hydration.details.some(detail => detail && this.serverReadHasLocalEdits(
          (this.data.projects || []).find(project => project.id === detail.id),
          (this._baseData?.projects || []).find(project => project.id === detail.id)));
        if (projectDraft || categoryDraft || detailDraft) return null;
        this.mergeProjectSummaries(hydration.projectSummaries);
        this.mergeSampleCategorySummaries(hydration.categorySummaries);
        const baseline = this.ensureHydrationBaseline();
        const projectIds = new Set(hydration.projectSummaries.map(project => project.id));
        const categoryIds = new Set(hydration.categorySummaries.map(category => category.id));
        baseline.projects = baseline.projects.filter(project => projectIds.has(project.id));
        baseline.sampleLibrary.categories = baseline.sampleLibrary.categories.filter(category => categoryIds.has(category.id));
        hydration.projectSummaries.forEach(summary => {
          const project = this.data.projects.find(project => project.id === summary.id);
          Object.assign(this.baselineProject(summary.id), this.cloneData(this.compactProjectForMutation(project)));
        });
        hydration.categorySummaries.forEach(summary => {
          const category = this.data.sampleLibrary.categories.find(category => category.id === summary.id);
          this.syncHydratedCategoryBaseline(this.compactSampleCategoryForMutation(category));
        });
        hydration.details.forEach(detail => {
          if (detail) {
            const merged = this.mergeProjectDetail(detail, { includeTasks: false });
            this.syncHydratedProjectBaseline(merged, { includeTasks: false });
          }
        });
        return hydration;
      });
      if (!hydration) {
        this.updateServerStatus("导入已写入，请刷新页面");
        return false;
      }

      if (!this.view.selectedProjectId || !(this.data.projects || []).some(project => String(project.id || "") === String(this.view.selectedProjectId))) {
        this.view.selectedProjectId = [...projectIds][0] || this.data.projects[0]?.id || null;
      }
      const currentProject = this.currentProject();
      if (currentProject && (!this.view.selectedStageId || !(currentProject.stages || []).some(stage => String(stage.id || "") === String(this.view.selectedStageId)))) {
        this.view.selectedStageId = currentProject.stages?.[0]?.id || null;
      }

      if (render) {
        this.renderNav?.();
        this.renderHeader?.();
        let contentRefreshed = false;
        if (this.view.module === "projectWorkspace") {
          const project = this.currentProject();
          const stage = this.currentStage();
          const selectedProjectAffected = projectIds.has(String(project?.id || ""));
          const selectedStageAffected = stageIds.has(String(stage?.id || "")) || selectedProjectAffected;
          if (project && stage && selectedStageAffected && typeof this.refreshCurrentTaskFlowPage === "function") {
            contentRefreshed = await this.refreshCurrentTaskFlowPage(project, stage);
          }
          if (!contentRefreshed && selectedProjectAffected && typeof this.renderContent === "function") {
            this.renderContent();
            contentRefreshed = true;
          }
        } else if (this.view.module === "samples") {
          const category = (this.data.sampleLibrary.categories || [])
            .find(cat => String(cat.id || "") === String(this.view.selectedCategoryId || ""));
          if (category && sampleCategoryIds.has(String(category.id || "")) && typeof this.refreshCurrentSamplePage === "function") {
            contentRefreshed = await this.refreshCurrentSamplePage(category);
          }
          if (!contentRefreshed && typeof this.renderContent === "function") {
            this.renderContent();
            contentRefreshed = true;
          }
        } else if ((this.view.module === "home" || this.view.module === "projects") && typeof this.renderContent === "function") {
          this.renderContent();
        }
      }

      this.updateServerStatus("已导入");
      return true;
    } catch (e) {
      console.error("导入后局部同步失败：", e);
      this.updateServerStatus("导入同步失败");
      return false;
    }
  },

  async importBundlePreview(file) {
    const form = new FormData();
    form.append("bundle", file);
    const resp = await fetch("/api/import-bundle/preview", { method: "POST", body: form });
    const json = await resp.json();
    if (!json.ok) throw new Error(json.error || "预览分析失败");
    return json;
  },

  async importBundleCommit(previewId, decisions) {
    const payload = JSON.stringify({ previewId, decisions, selection: this._importState?.selection || null });
    const release = await this.beginServerMutation();
    if (!release) throw new Error("平台数据已刷新，请重新预览后导入。");
    try {
      const resp = await fetch("/api/import-bundle/commit", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: payload,
      });
      const json = await resp.json();
      if (!resp.ok || !json.ok) throw new Error(json.error || "导入失败");
      this.serverRevision = Math.max(Number(this.serverRevision) || 0, Number(json.revision) || 0);
      return json;
    } finally { release(); }
  },

  async importSampleArchivePreview(file, targetCategoryId = "") {
    const form = new FormData();
    form.append("bundle", file);
    if (targetCategoryId) form.append("targetCategoryId", targetCategoryId);
    const resp = await fetch("/api/samples/archive/preview", { method: "POST", body: form });
    const json = await resp.json();
    if (!json.ok) throw new Error(json.error || "样机档案预览失败");
    return json;
  },

  async importSampleArchiveCommit(previewId, decisions = {}) {
    const payload = JSON.stringify({ previewId, decisions });
    const release = await this.beginServerMutation();
    if (!release) throw new Error("平台数据已刷新，请重新预览后导入。");
    try {
      const resp = await fetch("/api/samples/archive/commit", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: payload,
      });
      const json = await resp.json();
      if (!resp.ok || !json.ok) throw new Error(json.error || "样机档案导入失败");
      this.serverRevision = Math.max(Number(this.serverRevision) || 0, Number(json.revision) || 0);
      return json;
    } finally { release(); }
  },

});
