/* 分页缓存和局部刷新。能证明筛选/排序不变才原地补丁，否则重新请求当前页。
 * 依赖 app.core.js 注册器；index.html 在 app.init() 前按顺序加载。
 * 维护说明：docs/architecture.md。
 */
app.registerModule("server.cache", {

  applySamplePhotosMutationResult(sampleId, json = {}, { renderPanel = false, statusText = "已保存" } = {}) {
    const found = this.findSample(sampleId);
    this.serverRevision = Math.max(Number(this.serverRevision) || 0, Number(json.revision || json.newRevision) || 0);
    this.serverUpdatedAt = json.updated_at || json.updatedAt || new Date().toISOString();
    this.serverOnline = true;

    if (found?.sample && Array.isArray(json.photos)) {
      this._samplePhotoLoadVersions ||= {};
      this._samplePhotoLoadVersions[sampleId] = (this._samplePhotoLoadVersions[sampleId] || 0) + 1;
      found.sample.photos = json.photos;
      found.sample.photoCount = json.photos.length;
      found.sample.photosLoaded = true;
      found.sample.updatedAt = json.updated_at || json.updatedAt || Utils.now();
    }

    // Acknowledge asset fields before history invalidation adds its metadata.
    // Keep insertion order aligned with the live sample: the dirty-state guard
    // compares JSON snapshots, including fields first populated by an upload.
    if (found?.sample) this.syncHydratedSamplePatchBaseline(sampleId, {
      photos: found.sample.photos,
      photoCount: found.sample.photoCount,
      photosLoaded: found.sample.photosLoaded,
      updatedAt: found.sample.updatedAt,
    });
    if (found?.category?.id) this.invalidatePagedCaches({ categoryId: found.category.id });
    this.invalidateSampleHistoryCache(sampleId);

    if (renderPanel) this.refreshSampleArchivePanels?.(sampleId);

    this.updateServerStatus(statusText);
    return found?.sample || null;
  },

  invalidateSampleHistoryCache(sampleIds = []) {
    const ids = Array.isArray(sampleIds) ? sampleIds : [sampleIds];
    ids.map(id => String(id || "")).filter(Boolean).forEach(id => {
      if (this._sampleHistoryCache) delete this._sampleHistoryCache[id];
      if (this._sampleHistoryRequests) delete this._sampleHistoryRequests[id];
      const sample = this.findSample(id)?.sample;
      if (sample) {
        sample.historyLoaded = false;
        this.syncHydratedSamplePatchBaseline(id, { historyLoaded: false });
      }
    });
  },

  taskFlowQueryHasFilters(params = {}) {
    return ["sku", "flowStatus", "ownerName", "categoryKeyword", "caseKeyword", "dtsKeyword", "resultKeyword"]
      .some(key => String(params?.[key] || "").trim());
  },

  samplePageQueryHasFilters(params = {}) {
    return ["keyword", "status", "problemState", "reassembled", "owner", "borrower"]
      .some(key => String(params?.[key] || "").trim());
  },

  applyTaskStatusCountDelta(target, changes = []) {
    if (!target || !changes.length) return;
    const counts = { ...(target.statusCounts || {}) };
    changes.forEach(change => {
      const before = String(change.beforeStatus || "").trim();
      const after = String(change.afterStatus || "").trim();
      if (!before || !after || before === after) return;
      counts[before] = Math.max(0, Number(counts[before] || 0) - 1);
      counts[after] = Number(counts[after] || 0) + 1;
    });
    target.statusCounts = counts;
  },

  tryPatchCurrentTaskFlowPage(project, stage, affected = {}) {
    if (!stage?.id || !affected || affected.tasksTruncated) return false;
    if (!this._taskFlowPageCache || typeof this.taskFlowQueryParams !== "function" || typeof this.taskFlowCacheKey !== "function") return false;
    const isCurrentTaskFlow = this.view?.module === "projectWorkspace"
      && String(this.view?.selectedStageId || "") === String(stage.id || "");
    if (!isCurrentTaskFlow) return false;
    const params = this.taskFlowQueryParams(stage);
    if (this.taskFlowQueryHasFilters(params)) return false;
    const key = this.taskFlowCacheKey(stage, params);
    const cache = this._taskFlowPageCache?.key === key ? this._taskFlowPageCache : null;
    if (!cache || !Array.isArray(cache.rows)) return false;

    const affectedTasks = (affected.tasks || []).filter(task => String(task?.stageId || "") === String(stage.id || ""));
    const affectedTaskIds = (affected.taskIds || []).filter(Boolean).map(id => String(id));
    if (!affectedTaskIds.length || affectedTasks.length !== affectedTaskIds.length) return false;

    const rowByTaskId = new Map(cache.rows.map(row => [String(row?.task?.id || ""), row]));
    if (!affectedTaskIds.every(id => rowByTaskId.has(id))) return false;

    const stageTasksById = new Map((stage.tasks || []).map(task => [String(task.id || ""), task]));
    affectedTasks.forEach(task => {
      const id = String(task.id || "");
      const row = rowByTaskId.get(id);
      const mergedTask = stageTasksById.get(id) || task;
      if (row) row.task = mergedTask;
    });

    const statusChanges = (this._lastMutationAffectedChanges?.taskStatus || [])
      .filter(change => String(change.stageId || "") === String(stage.id || "") && affectedTaskIds.includes(String(change.taskId || "")));
    if (cache.stats) this.applyTaskStatusCountDelta(cache.stats, statusChanges);
    if (!(affected.stageSummaries || []).some(summary => summary.id === stage.id && summary.statusCounts)) {
      this.applyTaskStatusCountDelta(stage, statusChanges);
    }

    if (cache.stats) {
      const ownerNames = new Set(cache.stats.ownerNames || stage.ownerNames || []);
      affectedTasks.forEach(task => {
        const ownerName = this.taskOwnerName?.(task.owner || "") || "";
        if (ownerName) ownerNames.add(ownerName);
      });
      cache.stats.ownerNames = [...ownerNames].sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
      stage.ownerNames = cache.stats.ownerNames;
    }

    // Keep the patched current page, but cancel reads started before this mutation.
    this.invalidatePagedCaches({ stageId: stage.id });
    this._taskFlowPageCache = cache;
    this.refreshTaskFlowRegion(project, stage);
    this.syncHydratedStageBaseline(project.id, {
      id: stage.id, taskCount: stage.taskCount,
      statusCounts: stage.statusCounts || {}, ownerNames: stage.ownerNames || [],
    });
    return true;
  },

  async refreshTaskListAfterMutation(project, stage, { render = true, affected = null } = {}) {
    if (!stage?.id) return false;
    const isCurrentTaskFlow = this.view?.module === "projectWorkspace"
      && String(this.view?.selectedStageId || "") === String(stage.id || "");
    if (render && isCurrentTaskFlow && typeof this.refreshCurrentTaskFlowPage === "function") {
      if (this.tryPatchCurrentTaskFlowPage(project, stage, affected)) return true;
      this.invalidatePagedCaches({ stageId: stage.id });
      await this.refreshCurrentTaskFlowPage(project, stage);
      return true;
    }
    this.invalidatePagedCaches({ stageId: stage.id });
    if (render) this.render();
    return false;
  },

  tryPatchCurrentSamplePage(category, affected = {}) {
    if (!category?.id || !affected || affected.samplesTruncated) return false;
    if (typeof this.samplePageQueryParams !== "function" || typeof this.samplePageCacheKey !== "function") return false;
    const isCurrentSamplePage = this.view?.module === "samples"
      && String(this.view?.selectedCategoryId || "") === String(category.id || "");
    if (!isCurrentSamplePage) return false;
    const params = this.samplePageQueryParams(category);
    if (this.samplePageQueryHasFilters(params)) return false;
    const key = this.samplePageCacheKey(category, params);
    const cache = this.getSamplePageCache?.(key) || (this._samplePageCache?.key === key ? this._samplePageCache : null);
    if (!cache || !Array.isArray(cache.items)) return false;

    const affectedSamples = (affected.samples || []).filter(sample => String(sample?.categoryId || "") === String(category.id || ""));
    const affectedSampleIds = (affected.sampleIds || []).filter(Boolean).map(id => String(id));
    if (!affectedSampleIds.length || affectedSamples.length !== affectedSampleIds.length) return false;
    // Person filter options describe the entire pool, not just the patched page.
    // A changed assignment may add or remove the last occurrence of a name.
    if ((this._lastMutationAffectedChanges?.samplePerson || []).some(change =>
      String(change.categoryId || "") === String(category.id)
      && affectedSampleIds.includes(String(change.sampleId || "")))) return false;

    const itemById = new Map(cache.items.map(sample => [String(sample?.id || ""), sample]));
    if (!affectedSampleIds.every(id => itemById.has(id))) return false;

    const categorySamplesById = new Map((category.samples || []).map(sample => [String(sample.id || ""), sample]));
    cache.items = cache.items.map(sample => {
      const id = String(sample?.id || "");
      return affectedSampleIds.includes(id) ? (categorySamplesById.get(id) || sample) : sample;
    });
    if (cache.stats) {
      cache.stats.statusCounts = category.statusCounts || cache.stats.statusCounts || {};
      cache.stats.problemCounts = category.problemCounts || cache.stats.problemCounts || {};
      cache.stats.totalInCategory = category.sampleCount ?? cache.stats.totalInCategory;
    }
    this.invalidatePagedCaches({ categoryId: category.id });
    this.setSamplePageCache?.(cache);
    this.setSamplePageMeta?.(cache.filterKey || this.samplePageFilterKey?.(category, params), cache);
    this.refreshSamplePageRegion(category);
    return true;
  },

  async refreshSampleListAfterMutation(sampleOrCategory, { render = true, affected = null } = {}) {
    const categoryId = sampleOrCategory?.categoryId || sampleOrCategory?.id || "";
    if (!categoryId) return false;
    const category = this.data?.sampleLibrary?.categories?.find(c => String(c.id || "") === String(categoryId));
    const isCurrentSamplePage = category
      && this.view?.module === "samples"
      && String(this.view?.selectedCategoryId || "") === String(category.id || "");
    if (render && isCurrentSamplePage && typeof this.refreshCurrentSamplePage === "function") {
      if (this.tryPatchCurrentSamplePage(category, affected)) return true;
      this.invalidatePagedCaches({ categoryId });
      await this.refreshCurrentSamplePage(category);
      return true;
    }
    this.invalidatePagedCaches({ categoryId });
    if (render) this.render();
    return false;
  },

  invalidatePagedCaches({ stageId = "", categoryId = "" } = {}) {
    this._samplePageCacheGeneration = (this._samplePageCacheGeneration || 0) + 1;
    this.cancelTaskFlowPageRequestState?.(stageId);
    if (stageId && this._taskFlowPageCache?.stageId === stageId) this._taskFlowPageCache = null;
    if (!stageId && this._taskFlowPageCache) this._taskFlowPageCache = null;
    const clearSampleCacheStore = (store) => {
      if (!(store instanceof Map)) return;
      if (!categoryId) {
        store.clear();
        return;
      }
      [...store.entries()].forEach(([key, value]) => {
        if (String(value?.categoryId || "") === String(categoryId)) store.delete(key);
      });
    };
    clearSampleCacheStore(this._samplePageCaches);
    clearSampleCacheStore(this._samplePageMetaCaches);
    if (categoryId && this._samplePageCache?.categoryId === categoryId) this._samplePageCache = null;
    if (!categoryId && this._samplePageCache) this._samplePageCache = null;
    if (this._samplePageLoadingKeys instanceof Set) this._samplePageLoadingKeys.clear();
    this._samplePageLoadingKey = "";
    this._sampleCategorySummaryLoaded = false;
    this._sampleCategorySummaryLoading = false;
  },

});
