/* ========================================
   TestChamber V7 - Sample test history
   Split from the previous monolithic module.
   ======================================== */

app.registerModule("samples.history", {

  switchSampleArchiveTab(tab) {
    this.disposeSample3dPreviews?.();
    const shell = document.querySelector(".sample-archive-shell");
    const sampleId = shell?.dataset.sampleDetailId || this._activeSampleDetailId;
    document.querySelectorAll("[data-sample-archive-tab]").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.sampleArchiveTab === tab);
    });
    document.querySelectorAll("[data-sample-archive-panel]").forEach(panel => {
      panel.classList.toggle("active", panel.dataset.sampleArchivePanel === tab);
    });
    shell?.querySelectorAll(".sample-file-video video").forEach(video => video.pause());
    if ((tab === "ct" || tab === "pointcloud") && sampleId) this.loadSampleArchiveFiles(shell, tab);
    if ((tab === "photos" || tab === "history") && sampleId) {
      const sample = this.findSample(sampleId)?.sample;
      if (tab === "history" && sample && sample.historyLoaded !== true) {
        this.ensureSampleHistoryLoaded(sampleId, {
          page: 1,
          pageSize: 20,
          renderPanels: true
        }).catch(e => {
          console.error("加载样机测试履历失败：", e);
          Utils.toast("样机测试履历加载失败：" + (e.message || e));
        });
      } else if (sample && tab === "photos" && sample.photosLoaded !== true) {
        this.ensureSampleDetailsLoaded(sampleId, {
          photos: true,
          events: false,
          renderPanels: true
        }).catch(e => {
          console.error("加载样机详情数据失败：", e);
          Utils.toast("样机详情数据加载失败：" + (e.message || e));
        });
      } else if (sample && tab === "photos") {
        this.refreshProblemPhotoArchive(shell, sampleId);
      }
    }
  },

  sampleTaskResultPhotos(task, sampleId) {
    if (!task) return [];
    const sample = this.findSample(sampleId)?.sample || {};
    const photoById = new Map((sample.photos || []).filter(p => p?.id).map(p => [p.id, p]));
    const photos = [];
    (task.resultUploads || []).forEach(upload => {
      (upload.samples || [])
        .filter(item => item?.sampleId === sampleId)
        .forEach(item => {
          const refs = [...(item.photos || [])];
          const ids = new Set(refs.map(ref => ref.id));
          (item.problemRecords || []).forEach(record => this.problemPhotoIds(record).forEach(id => {
            if (!ids.has(id)) { refs.push({ id }); ids.add(id); }
          }));
          refs.forEach(ref => {
            if (!ref?.id) return;
            const full = photoById.get(ref.id) || {};
            photos.push({
              id: ref.id,
              name: ref.name || full.name || "结果图片",
              url: ref.url || full.url || "",
              thumbUrl: ref.thumbUrl || full.thumbUrl || "",
              uploadedAt: ref.uploadedAt || full.uploadedAt || upload.time || "",
              result: upload.result || "",
              user: upload.user || "",
              uploadTime: upload.time || ""
            });
          });
        });
    });
    const seen = new Set();
    return photos.filter(photo => {
      const key = `${photo.uploadTime || ""}_${photo.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },

  sampleHistoryPhotosHtml(sampleId, photos = []) {
    if (!photos.length) return "";
    return `<div class="sample-history-photos">
      <div class="sample-history-photos-title">结果图片</div>
      <div class="sample-history-photo-grid">
        ${photos.map(photo => `
          <button type="button" class="sample-history-photo" data-app-action="sample-photo-preview" data-id="${Utils.esc(sampleId)}" data-photo-id="${Utils.esc(photo.id)}" title="${Utils.esc(photo.name || "结果图片")}">
            ${this.photoThumbUrl(photo) ? `<img src="${Utils.esc(this.photoThumbUrl(photo))}" alt="${Utils.esc(photo.name || "结果图片")}">` : ""}
            <span>${Utils.esc(photo.result || "-")} · ${Utils.esc(photo.user || "-")}</span>
          </button>
        `).join("")}
      </div>
    </div>`;
  },

  sampleEventLogsForSample(sampleId) {
    return this.sampleEventRecords().filter(log => String(log?.sampleId || "") === String(sampleId));
  },

  sampleTestHistoryHtml(sampleId) {
    const cache = this._sampleHistoryCache?.[String(sampleId || "")];
    if (!cache || cache.loading) {
      return this.sampleArchivePlaceholder("正在加载测试履历", "测试履历按页从服务器读取。");
    }
    if (cache.error) {
      return this.sampleArchivePlaceholder("测试履历加载失败", cache.error);
    }
    const list = Array.isArray(cache.items) ? cache.items : [];
    if (!list.length) return this.sampleArchivePlaceholder("暂无测试履历", "该样机还没有被分配到任何测试任务。");

    const total = Number(cache.total || list.length);
    const page = Number(cache.page || 1);
    const pageSize = Number(cache.pageSize || 20);
    const offset = (page - 1) * pageSize;
    return `<div class="sample-history-list">${list.map((row, idx) => {
      const task = row.task || null;
      const logs = Array.isArray(row.logs) ? row.logs : [];
      const historySeq = Math.max(1, total - offset - idx);
      const status = row.status || (task ? this.taskFlowStatus(task) : "历史记录");
      const result = row.result || task?.latestResult || task?.result || "-";
      const date = row.date || task?.resultDate || task?.completedAt || task?.planDate || logs[logs.length - 1]?.time || "-";
      const taskSampleCount = Number(row.taskSampleCount || 0);
      const faultMarked = !!row.faultMarked;
      const problems = Array.isArray(row.problems) ? row.problems : [];
      const resultPhotos = Array.isArray(row.resultPhotos) ? row.resultPhotos : [];
      const orderedLogs = logs.slice().reverse();
      return `<div class="sample-history-item">
        <button type="button" class="sample-history-summary" aria-expanded="false" data-app-action="sample-history-toggle">
          <span class="history-seq">履历 #${historySeq}</span>
          <b>${Utils.esc(row.testItem || task?.testItem || "-")}</b>
          <span class="badge s-${Utils.esc(status)}">${Utils.esc(status)}</span>
          <span class="badge ${faultMarked ? "status-bad" : "status-done"}">${faultMarked ? "有故障" : "无故障"}</span>
          <span class="sample-history-toggle"></span>
        </button>
        <div class="sample-history-detail">
          <div class="sample-history-grid">
            <span>任务ID：<b>${Utils.esc(task?.id || logs[0]?.taskId || "-")}</b></span>
            <span>项目：<b>${Utils.esc(row.projectName || "-")}</b></span>
            <span>阶段：<b>${Utils.esc(row.stageName || "-")}</b></span>
            <span>执行人：<b>${Utils.esc(task?.owner || logs[0]?.user || "-")}</b></span>
            <span>结果：<b>${Utils.esc(result)}</b></span>
            <span>日期：<b>${Utils.esc(date)}</b></span>
            <span>样机数：<b>${taskSampleCount || "-"} 台</b></span>
          </div>
          ${this.deviceReferencesHtml?.(Object.prototype.hasOwnProperty.call(row, "deviceIds") || Object.prototype.hasOwnProperty.call(row, "deviceSnapshots") ? row : task) || ""}
          ${problems.length ? `<div class="sample-history-problems">问题：${problems.map(x => Utils.esc(x)).join("；")}</div>` : ""}
          ${this.sampleHistoryPhotosHtml(sampleId, resultPhotos)}
          ${orderedLogs.length ? `<div class="sample-history-logs">${orderedLogs.map((log, logIdx) => this.logHtml(log, orderedLogs.length - logIdx, "日志 #", task)).join("")}</div>` : `<div class="path">暂无该任务下的样机状态记录。</div>`}
        </div>
      </div>`;
    }).join("")}</div>${this.sampleHistoryPagerHtml(sampleId, cache)}`;
  },

  sampleHistoryPagerHtml(sampleId, cache = {}) {
    const totalPages = Number(cache.totalPages || 1);
    if (totalPages <= 1) return "";
    const page = Number(cache.page || 1);
    return `<div class="pager sample-history-pager">
      <button type="button" class="btn btn-sm btn-outline sample-history-page-btn" ${page <= 1 ? "disabled" : `data-app-action="sample-history-page" data-id="${Utils.esc(sampleId)}" data-value="${page - 1}"`}>上一页</button>
      <span>${page} / ${totalPages} · 共 ${Number(cache.total || 0)} 条</span>
      <button type="button" class="btn btn-sm btn-outline sample-history-page-btn" ${page >= totalPages ? "disabled" : `data-app-action="sample-history-page" data-id="${Utils.esc(sampleId)}" data-value="${page + 1}"`}>下一页</button>
    </div>`;
  },

  async loadSampleHistoryPage(sampleId, page) {
    try {
      await this.ensureSampleHistoryLoaded(sampleId, { page, pageSize: 20, renderPanels: true, force: true });
    } catch (e) {
      Utils.toast("样机测试履历加载失败：" + (e.message || e));
    }
  },

  // ---- 样机数字档案（含 IMEI）----,

  findSampleSnapshot(sampleId) {
    for (const project of this.projectRecords()) {
      for (const stage of (project.stages || [])) {
        for (const task of (stage.tasks || [])) {
          const snap = task?.sampleSnapshots?.[sampleId];
          if (snap) return { snapshot: snap, project, stage, task };
        }
      }
    }
    return null;
  },

  readonlySampleSnapshotHtml(sampleId, snap = {}) {
    const destroyed = !!snap.destroyedAt;
    const emptyText = destroyed
      ? "该样机档案已销毁，这里仅显示任务日志保留的只读快照。"
      : "未能在样机池中找到当前档案，这里仅显示任务日志保留的只读快照。";
    return `
      <div class="sample-archive-summary">
        <div><span>档案编号</span><b>${Utils.esc(snap.code || snap.sampleNo || sampleId)}</b></div>
        <div><span>所属样机池</span><b>${Utils.esc(snap.categoryName || "-")}</b></div>
        <div><span>快照时间</span><b>${Utils.esc(snap.destroyedAt || snap.capturedAt || "-")}</b></div>
      </div>
      <div class="sample-archive-summary">
        <div><span>SN</span><b>${Utils.esc(snap.sn || "-")}</b></div>
        <div><span>IMEI</span><b>${Utils.esc(snap.imei || "-")}</b></div>
        <div><span>主板SN</span><b>${Utils.esc(snap.boardSn || "-")}</b></div>
      </div>
      <div class="empty">${emptyText}</div>
    `;
  },

  async openTaskSampleReadonly(sampleId, { task = null, snapshot = null, readonlyOkText = "" } = {}) {
    const request = this.beginDialogRequest?.();
    const parentTitle = String((typeof document !== "undefined" && document.getElementById?.("modalTitle")?.innerText) || "");
    const okText = readonlyOkText || (parentTitle.startsWith("任务日志") ? "返回日志" : "关闭");
    const snap = snapshot || task?.sampleSnapshots?.[sampleId] || this.findSampleSnapshot(sampleId)?.snapshot || null;
    const lookupValues = typeof this.sampleLookupIdentityValues === "function"
      ? this.sampleLookupIdentityValues(sampleId, snap)
      : [sampleId];
    let found = this.findSampleByLookupValues?.(lookupValues) || this.findSample(sampleId);
    if (!found && typeof this.ensureSampleLoaded === "function") {
      found = await this.ensureSampleLoaded(sampleId, { snapshot: snap });
    }
    if (this.isDialogRequestCurrent?.(request) === false) return;
    if (found) {
      this.openSampleDetail(found.sample.id, { readonly: true, readonlyOkText: okText });
      return;
    }
    if (this._lastSampleLookupError) {
      alert("样机档案加载失败：" + (this._lastSampleLookupError.message || this._lastSampleLookupError));
      return;
    }
    if (!snap) { alert("该样机档案不存在，且没有保留任务快照。"); return; }
    this.showModal(
      "样机档案快照：" + (snap.code || snap.sampleNo || sampleId),
      this.readonlySampleSnapshotHtml(sampleId, snap),
      () => false,
      okText,
      { hideCancel: true, className: "sample-archive-modal", headerHint: "只读快照，不能编辑" }
    );
  },

  async openSampleReadonly(sampleId, options = {}) {
    return this.openTaskSampleReadonly(sampleId, options);
  },

});
