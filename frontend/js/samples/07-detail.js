/* ========================================
   TestChamber V7 - Sample detail modal
   Split from the previous monolithic module.
   ======================================== */

app.registerModule("samples.detail", {

  async openSampleDetail(sampleId, options = {}) {
    let found = this.findSample(sampleId);
    if (!found) return;
    const dialogRequest = this.beginDialogRequest?.();
    const request = (this._sampleDetailOpenSequence || 0) + 1;
    this._sampleDetailOpenSequence = request;
    const modalId = this._currentModalId;
    const viewKey = JSON.stringify([this.view?.module, this.view?.selectedProjectId, this.view?.selectedCategoryId]);
    const context = this.ensureSamplePersonContextLoaded?.({ sample: found.sample });
    if (context?.then) {
      if (!await context) return;
      if (this._sampleDetailOpenSequence !== request || this._currentModalId !== modalId
        || JSON.stringify([this.view?.module, this.view?.selectedProjectId, this.view?.selectedCategoryId]) !== viewKey) return;
      found = this.findSample(sampleId);
      if (!found) return;
    }
    if (this.isDialogRequestCurrent?.(dialogRequest) === false) return;
    const hadLocalUnsavedChanges = this.hasLocalUnsavedChanges?.() === true;
    this._activeSampleDetailId = sampleId;
    const readonly = !!options.readonly;
    const s = found.sample;
    const summaryStatus = this.sampleEffectiveStatus(s) || "—";
    const summaryStatusClass = summaryStatus === "—" ? "待确认" : summaryStatus;
    this.showModal("样机详情 · " + this.sampleDisplayCode(s), `
      <div class="sample-summary-bar">
        <div class="sample-summary-card"><span class="sample-summary-label">档案编号</span><b class="sample-summary-value">${Utils.esc(this.sampleDisplayCode(s))}</b></div>
        <div class="sample-summary-card"><span class="sample-summary-label">质量</span><b class="sample-summary-value" style="color:var(--status-sample-quality-${this.sampleHasProblem(s) ? 'fault' : 'ok'}-text)">${this.sampleHasProblem(s) ? '有故障' : '无故障'}</b></div>
        <div class="sample-summary-card"><span class="sample-summary-label">重组样机</span><b class="sample-summary-value" style="color:var(--status-sample-reassembly-${this.sampleIsReassembled(s) ? 'reassembled' : 'normal'}-text)">${this.sampleIsReassembled(s) ? '是' : '否'}</b></div>
        <div class="sample-summary-card"><span class="sample-summary-label">当前状态</span><b class="sample-summary-value sample-summary-status s-${Utils.esc(summaryStatusClass)}">${Utils.esc(summaryStatus)}</b></div>
        <div class="sample-summary-card"><span class="sample-summary-label">当前任务</span><b class="sample-summary-value">${Utils.esc(s.currentTestItem || "—")}</b></div>
      </div>
      <div class="sample-archive-shell" data-sample-detail-id="${Utils.esc(sampleId)}" data-readonly="${readonly ? "1" : "0"}">
        <aside class="sample-archive-nav">
          <button type="button" class="active" data-sample-archive-tab="info" data-app-action="sample-archive-tab" data-tab="info">样机信息</button>
          <button type="button" data-sample-archive-tab="problems" data-app-action="sample-archive-tab" data-tab="problems">样机问题表</button>
          <button type="button" data-sample-archive-tab="history" data-app-action="sample-archive-tab" data-tab="history">测试履历</button>
          <button type="button" data-sample-archive-tab="photos" data-app-action="sample-archive-tab" data-tab="photos">图片数据</button>
          <button type="button" data-sample-archive-tab="ct" data-app-action="sample-archive-tab" data-tab="ct">CT三维数据</button>
          <button type="button" data-sample-archive-tab="pointcloud" data-app-action="sample-archive-tab" data-tab="pointcloud">点云数据</button>
          <button type="button" data-sample-archive-tab="other" data-app-action="sample-archive-tab" data-tab="other">其他</button>
        </aside>
        <div class="sample-archive-content">
          <section class="sample-archive-panel active" data-sample-archive-panel="info">
            <div style="display:flex;flex-direction:column;gap:16px">
              <div class="form-row sample-id-row">
                <div class="form-group" style="margin-bottom:0"><label>SN</label><input id="sdSn" data-app-action="sample-reassembly-refresh" data-app-events="change" value="${Utils.esc(s.sn || "")}" placeholder="序列号"></div>
                <div class="form-group" style="margin-bottom:0"><label>IMEI</label><input id="sdImei" data-app-action="sample-reassembly-refresh" data-app-events="change" value="${Utils.esc(s.imei || "")}" placeholder="IMEI号"></div>
                <div class="form-group" style="margin-bottom:0"><label>主板SN</label><input id="sdBoardSn" data-app-action="sample-reassembly-refresh" data-app-events="change" value="${Utils.esc(s.boardSn || "")}" placeholder="主板序列号"></div>
              </div>
              <div class="form-row form-row-three">
                <div class="form-group" style="margin-bottom:0"><label>阶段</label><input id="sdStage" value="${Utils.esc(s.sourceStageName || "")}" placeholder="如 V3-1"></div>
                <div class="form-group" style="margin-bottom:0"><label>方案</label><input id="sdConfig" value="${Utils.esc(s.config || s.model || "")}" placeholder="制式/配置/型号/SKU"></div>
                <div class="form-group" style="margin-bottom:0"><label>方案编号</label><input id="sdSchemeNo" value="${Utils.esc(s.schemeNo || "")}" placeholder="如 B1"></div>
              </div>
              <div class="form-row sample-reassembly-row">
                <div class="form-group" style="margin-bottom:0"><label>重组样机</label><select id="sdReassembled" data-app-action="sample-reassembly-refresh" data-app-events="change"><option value="否" ${!this.sampleIsReassembled(s) ? 'selected' : ''}>否</option><option value="是" ${this.sampleIsReassembled(s) ? 'selected' : ''}>是</option></select></div>
                <div class="form-group sample-reassembly-sources" style="margin-bottom:0"><label>重组来源</label><div id="sdReassemblySources">${this.sampleReassemblySourcesHtml(s)}</div></div>
              </div>
              <div class="form-row sample-custody-row">
                <div class="form-group" style="margin-bottom:0"><label>挂账人</label>${this.samplePersonInputHtml("sdOwner", s.owner || "", "姓名/工号", { scope: "all", sample: s })}</div>
                <div class="form-group" style="margin-bottom:0"><label>样机状态</label><select id="sdStatus" ${s.currentTaskId ? 'disabled aria-describedby="sdStatusHint"' : ''}>${this.constants.sampleStatuses.map(x => `<option ${s.status === x ? 'selected' : ''}>${x}</option>`).join("")}</select>${s.currentTaskId ? '<div class="path" id="sdStatusHint">任务正在占用或预约此样机，请通过任务结束、变更或取消分配来释放。</div>' : ''}</div>
                <div class="form-group" style="margin-bottom:0"><label>持有人/取走人</label>${this.samplePersonInputHtml("sdBorrower", s.borrower || "", "姓名/工号", { scope: "developer", sample: s })}</div>
                <div class="form-group" style="margin-bottom:0"><label>当前位置</label>${this.sampleLocationInputHtml("sdLocation", s.location || "")}</div>
              </div>
              <div class="form-group" style="margin-bottom:0"><label>其他备注信息</label><textarea id="sdNotes" rows="2" style="min-height:56px">${Utils.esc(s.notes || "")}</textarea></div>
            </div>
          </section>
          <section class="sample-archive-panel" data-sample-archive-panel="problems">
            <h3 class="sample-problems-title">样机问题表</h3>
            ${this.sampleProblemsHtml("sdInitialResults", this.sampleProblemRecords(s))}
          </section>
          <section class="sample-archive-panel" data-sample-archive-panel="photos">
            ${this.samplePhotosHtml(s)}
          </section>
          <section class="sample-archive-panel" data-sample-archive-panel="history">
            ${this.sampleTestHistoryHtml(s.id)}
          </section>
          <section class="sample-archive-panel" data-sample-archive-panel="ct">
            ${this.sampleFilesPanelHtml(sampleId, "ct", readonly)}
          </section>
          <section class="sample-archive-panel" data-sample-archive-panel="pointcloud">
            ${this.sampleFilesPanelHtml(sampleId, "pointcloud", readonly)}
          </section>
          <section class="sample-archive-panel" data-sample-archive-panel="other">
            ${this.sampleArchivePlaceholder("暂无内容", "其他功能模块尚未定义，后续可在此处扩展。")}
          </section>
        </div>
      </div>
    `, async () => {
      if (readonly) return false;
      // A previous failed save may have restored the data tree while keeping this form open.
      const found = this.findSample(sampleId);
      const s = found?.sample;
      if (!s) { alert("样机档案已不存在，请关闭详情后刷新。"); return true; }
      this.clearFieldValidationMarks();
      const newSn = document.getElementById("sdSn").value.trim();
      const newImei = document.getElementById("sdImei").value.trim();
      const newBoardSn = document.getElementById("sdBoardSn").value.trim();
      const nextReassembled = document.getElementById("sdReassembled").value === "是";
      if (!newSn && !newImei && !newBoardSn) {
        this.markFieldInvalid(document.getElementById("sdSn"), "SN、IMEI 和主板SN至少需要填写一个。");
        this.markFieldInvalid(document.getElementById("sdImei"), "SN、IMEI 和主板SN至少需要填写一个。");
        this.markFieldInvalid(document.getElementById("sdBoardSn"), "SN、IMEI 和主板SN至少需要填写一个。");
        return true;
      }

      const newIdentity = { sn: newSn, imei: newImei, boardSn: newBoardSn };
      const identityChanged = this.sampleIdentifierSignature(s) !== this.sampleIdentifierSignature(newIdentity);
      const reassembledChanged = this.sampleIsReassembled(s) !== nextReassembled;
      // 自校验：同一台样机的 SN/IMEI/主板SN 互不相同
      const selfDup = this.validateSampleSelfDuplicate(newSn, newImei, newBoardSn, "sd");
      if (selfDup) { this.markFieldInvalid(document.getElementById(selfDup.field), selfDup.msg); return true; }

      if (identityChanged || reassembledChanged) {
        const epoch = this._dataSnapshotEpoch || 0;
        try {
          const duplicate = await this._checkServerIdentityDuplicate(newSn, newImei, newBoardSn, nextReassembled, found.category.id, s.id, "sd");
          if ((this._dataSnapshotEpoch || 0) !== epoch || this.findSample(sampleId)?.sample !== s) return true;
          if (duplicate) { this.markFieldInvalid(document.getElementById(duplicate.fieldId), duplicate.msg); return true; }
        } catch (e) {
          alert("样机身份查重失败：" + (e.message || e));
          return true;
        }
      }
      const location = document.getElementById("sdLocation").value.trim();

      // 人员字段校验（复用全局 parsePersonField）
      const sdOwnerEl = document.getElementById("sdOwner");
      const sdBorrowerEl = document.getElementById("sdBorrower");
      const sdOwnerRaw = sdOwnerEl.value.trim();
      const sdBorrowerRaw = sdBorrowerEl?.value.trim() || "";
      // Imported or previously assigned personnel can outlive their project role.
      // Preserve an unchanged value; only a new assignment uses current membership rules.
      const ownerCheck = this.normalizePersonText(sdOwnerRaw) === this.normalizePersonText(s.owner || "")
        ? { ok: true, value: s.owner || "" }
        : sdOwnerRaw ? this.collectSamplePersonValue(sdOwnerEl, "all", "挂账人") : { ok: true, value: "" };
      const borrowerCheck = this.normalizePersonText(sdBorrowerRaw) === this.normalizePersonText(s.borrower || "")
        ? { ok: true, value: s.borrower || "" }
        : sdBorrowerRaw ? this.collectSamplePersonValue(sdBorrowerEl, "developer", "持有人/取走人") : { ok: true, value: "" };
      if (!ownerCheck.ok) { this.markFieldInvalid(sdOwnerEl, ownerCheck.msg); return true; }
      if (!borrowerCheck.ok) { this.markFieldInvalid(sdBorrowerEl, borrowerCheck.msg); return true; }

      const snapshot = this.dataSnapshot();
      const previousRoute = {
        status: this.sampleEffectiveStatus(s),
        location: String(s.location || "").trim(),
        owner: this.normalizePersonText(s.owner || ""),
        borrower: this.normalizePersonText(s.borrower || "")
      };
      s.sn = newSn;
      s.imei = newImei;
      s.boardSn = newBoardSn;
      s.isReassembled = nextReassembled;
      s.sampleNo = newSn || newImei || newBoardSn || s.sampleNo;
      s.model = "";
      s.config = document.getElementById("sdConfig").value.trim();
      s.schemeNo = document.getElementById("sdSchemeNo").value.trim();
      this.replaceSampleProblemRecords(s, this.collectSampleProblems("sdInitialResults"));
      s.sourceStageName = document.getElementById("sdStage").value.trim();
      s.sourceSkuName = s.config || "Unknown";
      // 人员字段已在上面校验通过，此处规范化为 姓名/工号
      const ownerText = ownerCheck.value;
      const borrowerText = borrowerCheck.value;
      const nextStatus = document.getElementById("sdStatus").value;
      if (s.status !== nextStatus || previousRoute.location !== location
        || previousRoute.owner !== this.normalizePersonText(ownerText)
        || previousRoute.borrower !== this.normalizePersonText(borrowerText)) {
        this.changeSampleStatus(s.id, nextStatus, {
          user: "管理员",
          source: "样机详情编辑",
          reason: "手动编辑样机详情",
          receiver: borrowerText,
          borrower: borrowerText,
          accountOwner: ownerText,
          destLocation: location,
          forceLog: true
        });
      }
      s.location = location;
      s.notes = document.getElementById("sdNotes").value.trim();
      s.updatedAt = Utils.now();
      const saved = await this.commitSampleMutation(s, {
        action: "sample_detail_update",
        remark: "样机详情编辑",
        user: "管理员"
      });
      if (!saved) {
        this.restoreDataSnapshot(snapshot);
        return true;
      }
      Utils.toast("样机详情已保存");
      return false;
    }, readonly ? (options.readonlyOkText || "关闭") : "确认", { hideCancel: readonly, headerHint: readonly ? "只读查看，不能编辑" : "" });
    document.querySelector(".modal")?.classList.add("sample-archive-modal");
    const footer = document.querySelector(".modal-footer");
    if (footer) {
      const exportButton = document.createElement("button");
      exportButton.type = "button";
      exportButton.id = "sampleArchiveExportBtn";
      exportButton.className = "sample-archive-export-footer";
      exportButton.title = "导出样机档案";
      exportButton.setAttribute("aria-label", "导出样机档案");
      exportButton.dataset.appAction = "sample-archive-export";
      exportButton.dataset.id = sampleId;
      this.replaceHtml(exportButton, Utils.iconHtml("download"));
      footer.prepend(exportButton);
    }
    if (!hadLocalUnsavedChanges) this.markDataSynced?.();
    if (readonly) this.applySampleArchiveReadonly();
  },

  applySampleArchiveReadonly() {
      const body = document.getElementById("modalBody");
      body?.querySelectorAll(".sample-archive-content input, .sample-archive-content select, .sample-archive-content textarea").forEach(el => { el.disabled = true; });
      body?.querySelectorAll(".sample-archive-content button:not(.sample-history-photo):not(.sample-photo-thumb):not(.sample-history-summary):not(.sample-reassembly-link):not(.sample-history-page-btn):not(.problem-photo-link):not(.sample-file-control):not(.device-reference-link)").forEach(el => { el.disabled = true; });
      body?.querySelectorAll('.sample-archive-content [data-app-action="sample-photo-upload"]').forEach(el => {
        el.removeAttribute("data-app-action");
        el.hidden = true;
      });
      body?.querySelectorAll('.sample-initial-result-row').forEach(row => this.refreshProblemPhotoButton(row));
  },

  refreshSampleArchivePanels(sampleId) {
    const shell = document.querySelector(".sample-archive-shell");
    const activeSampleId = shell?.dataset.sampleDetailId || this._activeSampleDetailId;
    if (activeSampleId !== sampleId) return;
    const sample = this.findSample(sampleId)?.sample;
    if (!sample) return;
    const photosPanel = document.querySelector('[data-sample-archive-panel="photos"]');
    if (photosPanel) this.replaceHtml(photosPanel, this.samplePhotosHtml(sample));
    const historyPanel = document.querySelector('[data-sample-archive-panel="history"]');
    if (historyPanel) this.replaceHtml(historyPanel, this.sampleTestHistoryHtml(sampleId));
    if (shell?.dataset.readonly === "1") this.applySampleArchiveReadonly();
  },

});
