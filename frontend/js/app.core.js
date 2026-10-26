/* ========================================
   数字治理平台 V7 - 核心框架
   ======================================== */

const testChamberVersionMeta = document.querySelector('meta[name="testchamber-version"]');

const app = {
  version: (testChamberVersionMeta?.getAttribute("content") || "").trim() || "dev",
  _modules: {},
  _moduleOwners: {},
  state: {
    data: null,
    view: {
      module: "home",
      selectedProjectId: null,
      selectedStageId: null,
      stageStrategyId: null,
      selectedCategoryId: null,
      sampleKeyword: "",
      sampleStatusFilter: "",
      sampleProblemFilter: "",
      sampleReassemblyFilter: "",
      sampleOwnerFilter: "",
      sampleBorrowerFilter: "",
      samplePage: 1,
      samplePageSize: 100,
      collapsed: {},
      progressFilters: {},
      stageStrategyFilters: { includeKeyword: "", excludeKeyword: "" },
      taskFlowFilters: {},
      taskFlowFilterDrafts: {},
      taskFlowPage: 1,
      taskFlowPageSize: 25,
      sidebarCollapsed: false
    }
  },
  get data() {
    return this.state.data;
  },
  set data(value) {
    this.state.data = value;
  },
  get view() {
    return this.state.view;
  },
  set view(value) {
    this.state.view = value || {};
  },
  serverRevision: 0,
  serverUpdatedAt: null,
  serverAppVersion: "",
  serverVersionMismatch: false,
  serverOnline: false,
  // 服务器已确认的字段基线，用于检测未保存编辑及三方合并。
  // 按需加载只补对应实体的基线，不能直接把整份 data 复制进来。
  _baseData: null,
  // bootstrap/分页状态不是完整数据库镜像，不能据此删除未加载的记录。
  _statePartial: false,
  _projectDetailPromises: {},
  _projectSelectionSequence: 0,
  _sampleCategoryDetailPromises: {},
  _taskFlowRequestSequence: 0,
  _taskFlowActiveRequest: null,
  _modalStack: [],
  _restoringModal: false,
  _currentModalOnOk: null,
  _currentModalOnCancel: null,
  _modalSequence: 0,
  _currentModalId: null,
  _modalBusy: false,

  constants: {
    sampleStatuses: ["测试中", "闲置", "在位等待", "已退库", "取走分析"],
    taskStatuses: ["待下发", "进行中", "阻塞中", "正常完成", "异常终止"],
    modules: {
      home: "首页",
      projects: "项目管理",
      projectWorkspace: "项目工作台",
      samples: "样机档案池",
      devices: "测试设备仓库"
    }
  },

  isImeCompositionEvent(event) {
    return !!(event?.isComposing || event?.keyCode === 229 || event?.which === 229);
  },

  registerModule(name, members) {
    const moduleName = String(name || "").trim() || "anonymous";
    if (!members || typeof members !== "object") {
      throw new Error(`模块 ${moduleName} 注册失败：members 必须是对象`);
    }
    if (!this._modules) this._modules = {};
    if (!this._moduleOwners) this._moduleOwners = {};
    if (this._modules[moduleName]) {
      throw new Error(`模块重复注册：${moduleName}`);
    }
    Object.keys(members).forEach(key => {
      if (Object.prototype.hasOwnProperty.call(this, key) && !Object.prototype.hasOwnProperty.call(this._moduleOwners, key)) {
        this._moduleOwners[key] = "core";
      }
      if (Object.prototype.hasOwnProperty.call(this._moduleOwners, key)) {
        const owner = this._moduleOwners[key];
        if (owner !== moduleName && typeof console !== "undefined" && console.warn) {
          console.warn(`app 成员覆盖：${key}，${owner} -> ${moduleName}`);
        }
      }
      this[key] = members[key];
      this._moduleOwners[key] = moduleName;
    });
    this._modules[moduleName] = Object.keys(members);
    return this;
  },

  htmlFragment(html) {
    if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
    const template = document.createElement("template");
    template.innerHTML = String(html || "");
    return template.content || null;
  },

  replaceHtml(target, html) {
    if (!target) return null;
    const fragment = this.htmlFragment(html);
    if (fragment && typeof target.replaceChildren === "function") {
      target.replaceChildren(...Array.from(fragment.childNodes || []));
    } else {
      target.innerHTML = String(html || "");
    }
    return target;
  },

  cloneChildNodes(target) {
    return Array.from(target?.childNodes || [])
      .map(node => node?.cloneNode ? node.cloneNode(true) : null)
      .filter(Boolean);
  },

  replaceWithClonedNodes(target, nodes = []) {
    if (!target) return null;
    const clones = (nodes || [])
      .map(node => node?.cloneNode ? node.cloneNode(true) : node)
      .filter(Boolean);
    if (typeof target.replaceChildren === "function") target.replaceChildren(...clones);
    return target;
  },

  resetEventTarget(target) {
    if (!target || !target.parentNode || typeof target.cloneNode !== "function") return target || null;
    const clone = target.cloneNode(true);
    target.parentNode.replaceChild(clone, target);
    return clone;
  },

  bindDelegatedEvents() {
    if (this._delegatedEventsBound || typeof document === "undefined") return;
    this._delegatedEventsBound = true;
    document.addEventListener("click", event => this.handleDelegatedAction(event, "click"));
    document.addEventListener("change", event => this.handleDelegatedAction(event, "change"));
    document.addEventListener("input", event => this.handleDelegatedAction(event, "input"));
    document.addEventListener("keydown", event => this.handleDelegatedAction(event, "keydown"));
    document.addEventListener("focusout", event => this.handleDelegatedAction(event, "focusout"));
    document.addEventListener("focusin", event => this.handleDelegatedAction(event, "focusin"));
    document.addEventListener("dblclick", event => this.handleDelegatedAction(event, "dblclick"));
    document.addEventListener("dragstart", event => this.handleDelegatedAction(event, "dragstart"));
    document.addEventListener("dragover", event => this.handleDelegatedAction(event, "dragover"));
    document.addEventListener("dragleave", event => this.handleDelegatedAction(event, "dragleave"));
    document.addEventListener("drop", event => this.handleDelegatedAction(event, "drop"));
    document.addEventListener("dragend", event => this.handleDelegatedAction(event, "dragend"));
  },

  handleDelegatedAction(event, eventType = "") {
    const target = event.target?.closest?.("[data-app-action]");
    if (!target) return;
    const action = target.dataset.appAction || "";
    if (!action) return;
    const supportedEvents = (target.dataset.appEvents || "click").split(/\s+/).filter(Boolean);
    const keyboardButton = eventType === "keydown" && target.getAttribute?.("role") === "button";
    const keyboardActivation = keyboardButton && !this.isImeCompositionEvent(event) && (event.key === "Enter" || event.key === " ");
    if (keyboardButton && !keyboardActivation) return;
    if (!supportedEvents.includes(eventType) && !keyboardActivation) return;
    if (keyboardActivation) event.preventDefault();
    if (target.dataset.stopPropagation === "1") event.stopPropagation();
    if (eventType === "click" && target.closest("button,[role='button']")?.disabled) return;
    this.dispatchAppAction(action, target, event, eventType);
  },

  dispatchAppAction(action, target, event, eventType) {
    const id = target.dataset.id || "";
    const value = target.dataset.value ?? target.value ?? "";
    const module = target.dataset.module || "";
    const sampleFilter = target.dataset.sampleFilter || "";
    const projectId = target.dataset.projectId || "";
    const stageId = target.dataset.stageId || "";
    const taskId = target.dataset.taskId || "";
    const progressId = target.dataset.progressId || "";
    const field = target.dataset.field || "";
    const isFormField = ["INPUT", "TEXTAREA", "SELECT", "OPTION", "LABEL"].includes(target.tagName || "");
    if (eventType === "click" && !isFormField) event.preventDefault();
    switch (action) {
      case "go":
        this.go(module || value || "home");
        break;
      case "nav-toggle":
        this._navToggle(id);
        break;
      case "nav-go-sub":
        this._navGoSub(id);
        break;
      case "bundle-export":
        this.exportBundle();
        break;
      case "bundle-import":
        this.importBundle();
        break;
      case "browser-cache-clear":
        this.clearBrowserCache();
        break;
      case "toggle-section":
        this.toggleSection(id);
        break;
      case "toggle-sidebar":
        this.toggleSidebar();
        break;
      case "modal-close":
        this.requestModalClose();
        break;
      case "project-add":
        this.addProject();
        break;
      case "device-group-add":
        this.editDeviceGroup();
        break;
      case "device-group-edit":
        this.editDeviceGroup(id);
        break;
      case "device-group-open":
        this.openDeviceGroup(id);
        break;
      case "device-warehouse-refresh":
        this.loadDeviceWarehouse();
        break;
      case "device-add":
        this.editDevice();
        break;
      case "device-edit":
        this.editDevice(id);
        break;
      case "device-open":
        this.openDevice(id);
        break;
      case "device-reference": {
        let snapshot = null;
        try { snapshot = JSON.parse(target.dataset.deviceSnapshot || "null"); } catch (_) { /* ID lookup remains available. */ }
        this.openDeviceReference(target.dataset.deviceId || id, snapshot);
        break;
      }
      case "project-edit":
        this.editProject(id);
        break;
      case "project-select":
        this.selectProject(id);
        break;
      case "project-delete":
        this.deleteProject(id);
        break;
      case "project-export-scope":
        this.exportProjectBundle(id);
        break;
      case "sample-page":
        this.setSamplePage(value);
        break;
      case "sample-page-retry":
        this.refreshCurrentSamplePage(this.currentSampleCategory());
        break;
      case "sample-page-size":
        this.setSamplePageSize(target.value);
        break;
      case "sample-category-add":
        this.addSampleCategory();
        break;
      case "sample-category-open":
        this.openCategory(id);
        break;
      case "sample-category-edit":
        this.editSampleCategory(id);
        break;
      case "sample-category-delete":
        this.deleteSampleCategory(id);
        break;
      case "sample-pool-export-scope":
        this.exportSamplePoolBundle(id);
        break;
      case "sample-add":
        this.addSample(id);
        break;
      case "sample-open":
        this.openSampleDetail(id);
        break;
      case "sample-destroy":
        this.destroySample(id);
        break;
      case "sample-filter":
        this.updateSamplePoolFilter(sampleFilter, target.value, { render: eventType === "change" });
        break;
      case "sample-filter-search":
        if (eventType === "input") this.updateSamplePoolFilter("keyword", target.value, { render: false });
        if (eventType === "keydown" && event.key === "Enter" && !this.isImeCompositionEvent(event)) this.updateSamplePoolFilter("keyword", target.value, { render: true });
        break;
      case "sample-filters-clear":
        this.clearSamplePoolFilters();
        break;
      case "sample-template-download":
        this.downloadSampleTemplate();
        break;
      case "sample-batch-import":
        this.importSampleBatch(id);
        break;
      case "sample-archive-import":
        this.importSampleArchive(id);
        break;
      case "task-flow-page":
        this.setTaskFlowPage(value);
        break;
      case "task-flow-page-size":
        this.setTaskFlowPageSize(target.value);
        break;
      case "task-flow-filter":
        this.setTaskFlowFilter(field, target.value);
        break;
      case "task-flow-text-filter":
        if (eventType === "input") this.setTaskFlowTextFilter(field, target.value);
        if (eventType === "keydown") this.handleTaskFlowTextFilterKeydown(event, field, target.value);
        break;
      case "task-flow-clear":
        this.clearTaskFlowFilters();
        break;
      case "task-flow-retry":
        this.retryTaskFlowPage();
        break;
      case "task-show-samples":
        {
          const pending = this.showTaskSamples(projectId, stageId, taskId);
          if (pending?.catch) pending.catch(e => {
            console.error("任务样机清单打开失败：", e);
            alert("任务样机清单打开失败：" + (e.message || e));
          });
        }
        break;
      case "task-issue-record":
        this.openTaskIssueRecordModal(projectId, stageId, taskId);
        break;
      case "task-add":
        this.openAddTasksFromPoolModal();
        break;
      case "task-more-toggle":
        this.handleTaskOpMenuClick(target.closest(".task-more-menu, .task-op-menu") || target.parentElement);
        break;
      case "task-show-logs":
        this.closeTaskOpMenus();
        {
          const pending = this.showTaskLogs(projectId, stageId, taskId);
          if (pending?.catch) pending.catch(e => {
            console.error("任务日志打开失败：", e);
            alert("任务日志打开失败：" + (e.message || e));
          });
        }
        break;
      case "task-delete":
        this.closeTaskOpMenus();
        this.deleteTask(taskId);
        break;
      case "task-config":
        this.openTaskConfigPanel(projectId, stageId, progressId, taskId, "plan");
        break;
      case "task-start":
        this.startTask(projectId, stageId, taskId);
        break;
      case "task-result":
        this.uploadResult(projectId, stageId, taskId);
        break;
      case "task-block":
        this.blockTask(projectId, stageId, taskId);
        break;
      case "task-change":
        this.tempChangeTask(projectId, stageId, taskId);
        break;
      case "task-pool-selection":
        this.updateTaskPoolSelectionCount();
        break;
      case "task-pool-check-all":
        this.setTaskPoolChecked(value === "1" || value === "true");
        break;
      case "task-config-member-add":
        this.addProjectMember("tester", {
          afterSave: ({ identity }) => this.refreshTaskConfigMemberPickers(identity)
        });
        break;
      case "task-config-tab":
        this.switchTaskConfigTab(value || target.dataset.tab || "plan");
        break;
      case "task-device-refresh":
        this.refreshTaskDevicePicker();
        break;
      case "task-device-filter":
        this.filterTaskDevicePicker(target);
        break;
      case "task-device-select":
        this.selectTaskDevice(target);
        break;
      case "task-sample-picker-schedule":
        this.loadTaskSamplePickerPage(id);
        break;
      case "stage-select":
        this.selectWorkspaceStageState(id);
        this.render();
        break;
      case "stage-strategy-open":
        this.openStageStrategy(id);
        break;
      case "stage-delete":
        this.deleteStage(id);
        break;
      case "stage-copy":
        this.copyStage(id);
        break;
      case "stage-add":
        this.addStage();
        break;
      case "stage-sort-toggle":
        this.toggleStageSortMode();
        break;
      case "stage-drag":
        if (eventType === "dragstart") this.onStageDragStart(event, id, target);
        if (eventType === "dragover") this.onStageDragOver(event, id, target);
        if (eventType === "dragleave") this.onStageDragLeave(event, target);
        if (eventType === "drop") this.onStageDrop(event, id, target);
        if (eventType === "dragend") this.onStageDragEnd(event);
        break;
      case "project-member-edit":
        this.editProjectMember(id);
        break;
      case "project-member-remove":
        this.removeProjectMember(id);
        break;
      case "project-members-template":
        this.downloadProjectMembersTemplate();
        break;
      case "project-members-import":
        this.importProjectMembersCsv();
        break;
      case "project-member-add":
        this.addProjectMember(value || target.dataset.role || "tester");
        break;
      case "project-member-search":
        this.setProjectMemberSearch(target.value);
        break;
      case "project-member-selection":
        this.updateProjectMemberSelectionCount();
        break;
      case "project-members-clear-selection":
        this.clearProjectMemberSelection();
        break;
      case "project-members-bulk-remove":
        this.bulkRemoveProjectMembers();
        break;
      case "project-members-role-toggle":
        this.toggleProjectMemberRoleGroup(value);
        break;
      case "project-member-combobox":
        this.handleProjectMemberCombobox(target, event, eventType);
        break;
      case "project-member-combobox-option":
        this.selectProjectMemberComboboxOption(target);
        break;
      case "task-result-location-combobox":
        this.handleTaskResultLocationCombobox(target, event, eventType);
        break;
      case "task-result-location-option":
        this.selectTaskResultLocationOption(target);
        break;
      case "project-member-select-search":
        this.filterProjectMemberSelect(target);
        break;
      case "project-members-bulk-role":
        this.bulkUpdateProjectMembersRole(value);
        break;
      case "project-location-edit":
        this.editProjectLocation(Number(value));
        break;
      case "project-location-remove":
        this.removeProjectLocation(Number(value));
        break;
      case "project-location-add":
        this.addProjectLocation();
        break;
      case "project-default-sample-category":
        this.setProjectDefaultSampleCategory(target.value);
        break;
      case "sample-readonly":
        {
          const pending = this.openSampleReadonly(id, { readonlyOkText: target.dataset.returnText || "" });
          if (pending?.catch) pending.catch(e => {
            console.error("样机档案打开失败：", e);
            alert("样机档案打开失败：" + (e.message || e));
          });
        }
        break;
      case "sample-archive-tab":
        this.switchSampleArchiveTab(target.dataset.tab || value || "info");
        break;
      case "sample-reassembly-refresh":
        this.refreshSampleReassemblySources();
        break;
      case "sample-archive-export":
        this.exportSampleArchive(id);
        break;
      case "sample-history-toggle":
        this.toggleSampleHistoryItem(target);
        break;
      case "sample-history-page":
        this.loadSampleHistoryPage(id, value);
        break;
      case "sample-photo-preview":
        this.previewSamplePhoto(id, target.dataset.photoId || "");
        break;
      case "sample-photo-preview-close":
        if (target.dataset.selfOnly === "1" && event.target !== target) return;
        target.closest(".sample-photo-preview-mask")?.remove();
        break;
      case "sample-file-upload":
      case "sample-file-delete":
      case "sample-file-preview":
      case "sample-file-model-preview":
      case "sample-file-model-reset":
      case "sample-file-point-smaller":
      case "sample-file-point-larger":
      case "sample-file-reload":
        this.handleSampleFileAction(target, action.replace("sample-file-", ""));
        break;
      case "sample-photo-upload":
        this.uploadSamplePhotos(id);
        break;
      case "sample-photo-delete":
        this.deleteSamplePhoto(id, target.dataset.photoId || "");
        break;
      case "sample-photo-rename":
        this.startPhotoRename(target, id, target.dataset.photoId || "");
        break;
      case "task-result-photo-upload":
      case "problem-photos-open":
        this.openProblemPhotos(target);
        break;
      case "task-result-photo-remove":
        this.removeTaskResultPhoto(target);
        break;
      case "task-result-problem-remove":
        this.removeTaskResultProblemRow(target);
        break;
      case "task-result-destination":
        this.onTaskResultDestinationChange(target);
        break;
      case "task-result-finish-type":
        this.syncTaskResultFinishType(target);
        break;
      case "task-result-value":
        this.onTaskResultValueChange(target);
        break;
      case "task-result-photo-preview":
        this.previewSamplePhoto(id, target.dataset.photoId || "");
        break;
      case "sample-person-validate":
        this.validateSamplePersonInput(target);
        break;
      case "sample-problem-add":
        this.addSampleProblemRow(id);
        break;
      case "sample-problem-remove":
        this.removeSampleProblemRow(target);
        break;
      case "task-sample-picker-page":
        this.loadTaskSamplePickerPage(id, { page: Number(value) || 1 });
        break;
      case "task-sample-picker-filter":
        this.onTaskSamplePickerFilterChange(id, field, target.value);
        break;
      case "task-sample-picker-search":
        if (eventType === "input") {
          this.updateTaskSamplePickerSearchDraft(id, field, target.value);
          return;
        }
        if (eventType === "keydown" && (event.key !== "Enter" || this.isImeCompositionEvent(event))) return;
        this.applyTaskSamplePickerSearch(id);
        break;
      case "task-sample-picker-row":
        this.onTaskSampleRowClick(event, id, progressId, target.dataset.hintId || "", target);
        break;
      case "task-sample-picker-checkbox":
        this.onTaskSampleCheckboxChange(progressId, id, target.dataset.hintId || "", target);
        break;
      case "case-dropdown-search":
        this.filterCaseDropdown(target.value);
        break;
      case "inline-stage-name":
        if (eventType === "input") this.updateInlineStageName(target.value);
        if (eventType === "focusout") this.normalizeInlineStageName(target);
        break;
      case "inline-stage-skus":
        if (eventType === "input") this.updateInlineSkus();
        if (eventType === "focusout") this.normalizeInlineSkus();
        break;
      case "bom-add":
        this.addBomRow();
        break;
      case "matrix-sku-name":
        this.renameMatrixSku(Number(target.dataset.index), target);
        break;
      case "matrix-sku-add":
        this.addMatrixSku();
        break;
      case "matrix-sku-delete":
        this.removeMatrixSku(Number(target.dataset.index));
        break;
      case "bom-update":
        this.updateBom(Number(target.dataset.index), field, target.value);
        break;
      case "bom-delete":
        this.deleteBomRow(Number(target.dataset.index));
        break;
      case "stage-strategy-filter":
        this.setStageStrategyFilter(field, target.value);
        break;
      case "stage-strategy-clear":
        this.clearStageStrategyFilters();
        break;
      case "test-case-template-download":
        this.downloadTestCaseTemplate();
        break;
      case "test-case-import":
        this.importTestCaseXlsx();
        break;
      case "strategy-input": {
        const rowIndex = Number(target.dataset.index);
        if (eventType === "input") this.onStrategyInput(rowIndex, field, target);
        if (field === "category" || field === "item") {
          if (eventType === "focusin" || eventType === "click" || eventType === "input") {
            this.openCaseDropdown(rowIndex, field, target);
          }
        }
        if (field === "sampleSize" && eventType === "focusout") this.validateSampleSizeInput(target);
        break;
      }
      case "strategy-sku":
        this.updateStrategySku(Number(target.dataset.index), Number(target.dataset.sku), target.checked);
        break;
      case "strategy-delete":
        this.deleteStrategyRow(Number(target.dataset.index));
        break;
      case "strategy-add":
        this.addStrategyRow();
        break;
      case "inline-sku-add":
        this.addInlineSku();
        break;
      case "inline-sku-remove":
        this.removeInlineSku(target);
        break;
      case "sku-input-add":
        this.addSkuInput();
        break;
      case "sku-input-remove":
        this.removeSkuInput(target);
        break;
      default:
        if (typeof console !== "undefined" && console.warn) console.warn(`未知委托动作：${action}`);
    }
  },

  // ---- 初始化 ----
  async init() {
    try {
      const obj = await this.fetchBootstrapState();
      this.data = obj.data || this.emptyData();
      this.serverRevision = obj.revision || 0;
      this.serverUpdatedAt = obj.updated_at || null;
      this.serverAppVersion = await this.resolveServerVersion(obj);
      this.serverVersionMismatch = Boolean(this.serverAppVersion && this.serverAppVersion !== this.version);
      this.serverOnline = true;
      this._statePartial = obj.partial !== false;
      this._baseData = this.cloneData(this.data);
      if (this.serverVersionMismatch && !this._serverVersionAlertShown) {
        this._serverVersionAlertShown = true;
        const message = `平台前后端版本不一致：前端 ${this.version}，后端 ${this.serverAppVersion}。请重启后端服务或清除浏览器缓存后再试，否则新功能可能不会生效。`;
        console.warn(message);
        setTimeout(() => alert(message), 50);
      }
    } catch (e) {
      console.error("服务器数据读取失败：", e);
      this.serverOnline = false;
      this.data = this.emptyData();
      this._statePartial = false;
      setTimeout(() => alert("无法连接内网服务器 API，页面将以空白只读状态打开。请确认后端服务正在运行。\n\n" + e.message), 50);
    }
    this.normalize();
    this._baseData = this.cloneData(this.data);
    this.view.selectedProjectId = this.data.currentProjectId || this.data.projects[0]?.id || null;
    this.view.selectedStageId = this.data.currentStageId || this.currentProject()?.stages?.[0]?.id || null;
    this.view.stageStrategyId = null;
    this.bindDelegatedEvents();
    this.render();
    this.applySidebarState();
    this.updateServerStatus();
    if (this.serverVersionMismatch) this.updateServerStatus("版本不一致");
    if (this._normalizedChanged && !this._statePartial) {
      this._normalizedChanged = false;
      this.updateServerStatus("已清理本地数据");
    }
    // 全局任务操作菜单关闭事件（只绑定一次）
    if (!this._taskOpMenuEventsBound) {
      this._taskOpMenuEventsBound = true;
      document.addEventListener("click", (event) => {
        if (!event.target.closest(".task-op-menu, .task-more-menu")) {
          this.closeTaskOpMenus();
        }
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          this.closeTaskOpMenus(null, { restoreFocus: true });
          this.closeCaseDropdown?.();
        }
      });
    }
    // 全局 pointerdown 关闭用例搜索下拉框（只绑定一次）
    if (!this._caseDropdownEventsBound) {
      this._caseDropdownEventsBound = true;
      document.addEventListener("pointerdown", (event) => {
        const state = this._caseDropdownState;
        if (!state) return;
        const dd = document.getElementById("caseDropdown");
        const target = event.target;
        if (dd && dd.contains(target)) return;
        if (state.inputEl && state.inputEl === target) return;
        this.closeCaseDropdown();
      });
    }
    // 全局关闭项目人员组合下拉框（只绑定一次）
    if (!this._projectMemberComboboxEventsBound) {
      this._projectMemberComboboxEventsBound = true;
      document.addEventListener("pointerdown", (event) => {
        if (event.target?.closest?.(".project-member-picker")) return;
        this.closeProjectMemberComboboxes?.();
        this.closeTaskResultLocationComboboxes?.();
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          this.closeProjectMemberComboboxes?.();
          this.closeTaskResultLocationComboboxes?.();
        }
      });
    }
  },

};
