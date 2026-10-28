/* ========================================
   数字治理平台 V7 - 主渲染模块
   ======================================== */

app.registerModule("app.render", {

  // ---- 渲染引擎 ----
  render() {
    this.renderNav();
    this.renderHeader();
    this.renderContent();
  },

  /** 只刷新内容区（nav/header 不变时使用，避免不必要的 DOM 重建） */
  renderContent() {
    const ft = document.getElementById("pageFooter");
    if (ft) ft.style.display = "none";
    const fn = {
      home: this.renderHome,
      projects: this.renderProjects,
      projectWorkspace: this.renderProjectWorkspace,
      samples: this.renderSamples,
      devices: this.renderDevices
    }[this.viewModule()] || this.renderHome;
    fn.call(this);
    this.updateSelectPlaceholderState();
  },

  textEl(tag, text, className = "") {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = text;
    return el;
  },

  homeEntryCard({ module, className = "", icon, name, meta, style = "" }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `home-entry-card ${className}`.trim();
    button.dataset.appAction = "go";
    button.dataset.module = module;
    if (style) button.style.cssText = style;
    button.append(
      this.textEl("span", icon, "home-entry-icon"),
      this.textEl("span", name, "home-entry-name"),
      this.textEl("span", meta, "home-entry-meta")
    );
    return button;
  },

  homeCacheToolNode() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "home-cache-tool";
    button.dataset.appAction = "browser-cache-clear";
    button.title = "清除当前浏览器保存的本平台缓存，并重新载入页面";
    button.setAttribute("aria-label", "清除当前浏览器保存的本平台缓存，并重新载入页面");
    button.append(this.textEl("span", "↻", "home-cache-tool-icon"));
    return button;
  },

  renderHome() {
    const content = document.getElementById("content");
    if (!content) return;
    const { projectCount, samplePoolCount, sampleCount } = this.homeMetrics();
    const shell = document.createElement("section");
    shell.className = "home-shell";

    const brand = document.createElement("header");
    brand.className = "home-brand";
    const logoHeading = document.createElement("h1");
    logoHeading.className = "home-logo-heading";
    const logo = document.createElement("img");
    logo.className = "home-logo";
    logo.src = "/css/assets/aladdin-logo.png?v=150443a32837";
    logo.alt = "阿拉丁 ALADDIN";
    logo.width = 2169;
    logo.height = 725;
    logoHeading.append(logo);

    const title = document.createElement("p");
    title.className = "home-title";
    title.append(document.createTextNode("终端硬件测试数字治理平台 "));
    title.append(this.textEl("span", `V${this.version}`, "home-version"));
    brand.append(logoHeading);

    const grid = document.createElement("div");
    grid.className = "home-entry-grid";
    grid.append(
      this.homeEntryCard({ module: "projects", className: "project-entry", icon: "📁", name: "项目管理", meta: `${projectCount} 个项目` }),
      this.homeEntryCard({ module: "samples", className: "sample-entry", icon: "📦", name: "样机档案池", meta: `${samplePoolCount} 个样机池 · ${sampleCount} 台样机` }),
      this.homeEntryCard({ module: "devices", icon: "🔬", name: "测试设备仓库", meta: "按地域、部门管理" })
    );

    const signature = document.createElement("footer");
    signature.className = "home-signature";
    signature.append(title, this.textEl("p", "从执行走向治理", "home-slogan"));
    shell.append(brand, grid, signature, this.homeCacheToolNode());
    content.replaceChildren(shell);
  },

  renderPreserveScroll() {
    const el = document.getElementById("content");
    const y = el ? el.scrollTop : 0;
    this.render();
    requestAnimationFrame(() => {
      const el2 = document.getElementById("content");
      if (el2) el2.scrollTop = y;
    });
  },

  renderNav() {
    // 指纹缓存：nav 数据未变时跳过 DOM 重建，避免慢机器上点击丢失
    const expanded = this.navExpandedState();
    const fp = JSON.stringify(this.navFingerprintData());
    if (fp === this._navFingerprint) return;
    this._navFingerprint = fp;

    const items = [
      { id: "home", icon: "🏠", label: "首页" },
      { id: "projects", icon: "📁", label: "项目管理", sub: this.projectRecords().map(p => ({
          id: `proj_${p.id}`, label: p.name,
          active: this.isProjectNavActive(p.id)
        })) },
      { id: "samples", icon: "📦", label: "样机档案池", sub: this.sampleCategoryRecords().map(c => ({
          id: `cat_${c.id}`, label: c.name,
          active: this.isSampleCategoryNavActive(c.id)
        })) },
      { id: "devices", icon: "🔬", label: "测试设备仓库" }
    ];

    const nav = document.getElementById("nav");
    if (nav) nav.replaceChildren(...items.flatMap(item => {
      const hasSub = item.sub && item.sub.length > 0;
      const isExpanded = expanded[item.id] === true;
      const nodes = [this.navItemNode(item, { hasSub, isExpanded, active: this.isNavItemActive(item.id) })];
      if (hasSub) nodes.push(this.navSubNode(item.sub, isExpanded));
      return nodes;
    }));

    // 数据工具（侧栏底部）
    const navTools = document.getElementById("navTools");
    if (navTools) navTools.replaceChildren(
      this.navToolNode("bundle-export", "download", "导出完整数据包"),
      this.navToolNode("bundle-import", "upload", "导入数据包")
    );

    this.applySidebarState();
  },

  navItemNode(item, { hasSub = false, isExpanded = false, active = false } = {}) {
    const node = document.createElement("div");
    node.className = `nav-item ${active ? "active" : ""} ${hasSub ? "has-sub" : ""}`.trim();
    node.title = item.label;
    node.dataset.appAction = "go";
    node.dataset.module = item.id;

    const main = document.createElement("span");
    main.className = "nav-item-main";
    main.setAttribute("role", "button");
    main.setAttribute("aria-label", item.label);
    if (active) main.setAttribute("aria-current", "page");
    main.tabIndex = 0;
    main.dataset.appAction = "go";
    main.dataset.module = item.id;
    main.append(this.textEl("span", item.icon, "nav-icon"), this.textEl("span", item.label, "nav-label"));
    node.append(main);

    if (hasSub) {
      const toggle = document.createElement("span");
      toggle.className = `nav-toggle ${isExpanded ? "expanded" : ""}`.trim();
      toggle.title = `${isExpanded ? "折叠" : "展开"}子目录`;
      toggle.setAttribute("role", "button");
      toggle.setAttribute("aria-label", toggle.title);
      toggle.setAttribute("aria-expanded", isExpanded ? "true" : "false");
      toggle.tabIndex = 0;
      toggle.dataset.appAction = "nav-toggle";
      toggle.dataset.id = item.id;
      toggle.dataset.stopPropagation = "1";
      node.append(toggle);
    }
    return node;
  },

  navSubNode(items = [], isExpanded = false) {
    const sub = document.createElement("div");
    sub.className = `nav-sub ${isExpanded ? "open" : ""}`.trim();
    items.forEach(item => {
      const node = document.createElement("div");
      node.className = `nav-sub-item ${item.active ? "active" : ""}`.trim();
      node.title = item.label;
      node.dataset.appAction = "nav-go-sub";
      node.dataset.id = item.id;
      node.dataset.stopPropagation = "1";
      node.setAttribute("role", "button");
      node.setAttribute("aria-label", item.label);
      if (item.active) node.setAttribute("aria-current", "page");
      node.tabIndex = 0;
      node.textContent = item.label;
      sub.append(node);
    });
    return sub;
  },

  navToolNode(action, icon, label) {
    const node = document.createElement("div");
    node.className = "nav-tool-item";
    node.dataset.appAction = action;
    node.title = label;
    node.setAttribute("role", "button");
    node.setAttribute("aria-label", label);
    node.tabIndex = 0;
    const iconNode = this.textEl("span", "", "nav-tool-icon");
    iconNode.innerHTML = Utils.iconHtml(icon);
    node.append(iconNode, this.textEl("span", label, "nav-tool-label"));
    return node;
  },

  _navToggle(id) {
    this.toggleNavExpanded(id);
    this._navFingerprint = null;  // invalidate cache so expand/collapse renders
    this.renderNav();
  },

  async _navGoSub(subId) {
    const sep = subId.indexOf("_");
    const type = subId.slice(0, sep);
    const id = subId.slice(sep + 1);
    if (this.stageStrategyId() && typeof this.prepareStageStrategyNavigation === "function") {
      this.prepareStageStrategyNavigation();
    }
    if (type === "proj") {
      await this.selectProject(id);
      return;
    } else if (type === "cat") {
      this.selectSampleCategoryState(id);
    }
    this.render();
  },

  renderHeader() {
    const title = document.getElementById("pageTitle");
    if (title) title.replaceChildren(...this.breadcrumbNodes());
    const context = document.getElementById("contextText");
    if (context) context.innerText = "";
    const action = document.getElementById("actionArea");
    if (action) action.replaceChildren();
  },

  breadcrumbParts() {
    const parts = [{ label: "首页", module: "home" }];
    const p = this.currentProject();
    const cat = this.currentSampleCategory();
    const module = this.viewModule();
    if (module === "projects") {
      parts.push({ label: "项目管理", module: "projects" });
    } else if (module === "projectWorkspace") {
      parts.push({ label: "项目管理", module: "projects" });
      if (p) parts.push({ label: p.name, module: this.stageStrategyId() ? "projectWorkspace" : "" });
      if (this.stageStrategyId()) parts.push({ label: "阶段配置", module: "" });
    } else if (module === "samples") {
      parts.push({ label: "样机档案池", module: "samples" });
      if (cat) parts.push({ label: cat.name, module: "" });
    } else if (module === "devices") {
      parts.push({ label: "测试设备仓库", module: "devices" });
      const group = this.currentDeviceGroup?.();
      if (group) parts.push({ label: `${group.region}－${group.department}`, module: "" });
    }
    return parts;
  },

  breadcrumbNodes() {
    return this.breadcrumbParts().flatMap((part, idx, parts) => {
      const isLast = idx === parts.length - 1;
      const nodes = [];
      if (idx) nodes.push(this.textEl("em", ">"));
      if (part.module && !isLast) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.appAction = "go";
        button.dataset.module = part.module;
        button.textContent = part.label;
        nodes.push(button);
      } else {
        nodes.push(this.textEl("span", part.label));
      }
      return nodes;
    });
  },

  go(module) {
    if (this.stageStrategyId() && typeof this.prepareStageStrategyNavigation === "function") {
      this.prepareStageStrategyNavigation();
    }
    this.navigateModuleState(module);
    if (module === "devices") {
      this.view.selectedDeviceGroupId = null;
      this.loadDeviceWarehouse();
    }
    this.render();
  },

  // ---- 侧栏 ----
  toggleSidebar() {
    this.toggleSidebarCollapsed();
    try {
      localStorage.setItem("digital_governance_sidebar_collapsed", this.sidebarCollapsed() ? "1" : "0");
    } catch (_) { /* Browser storage can be disabled; retain the current session state. */ }
    this.applySidebarState({ readPersisted: false });
  },

  applySidebarState({ readPersisted = true } = {}) {
    if (readPersisted) {
      try {
        const persisted = localStorage.getItem("digital_governance_sidebar_collapsed");
        if (persisted !== null) this.setSidebarCollapsed(persisted === "1");
      } catch (_) { /* Rendering must also work when browser storage is unavailable. */ }
    }
    const sidebar = document.getElementById("sidebar");
    const toggle = document.getElementById("sidebarToggle");
    if (!sidebar) return;
    sidebar.classList.toggle("collapsed", this.sidebarCollapsed());
    if (toggle) {
      toggle.innerText = this.sidebarCollapsed() ? "▶" : "◀";
      toggle.title = this.sidebarCollapsed() ? "展开左侧栏" : "收起左侧栏";
      toggle.setAttribute?.("aria-expanded", this.sidebarCollapsed() ? "false" : "true");
      toggle.setAttribute?.("aria-label", toggle.title);
    }
  },

  // ---- 折叠 ----
  isCollapsed(sectionId) {
    return this.isSectionCollapsed(sectionId);
  },
  collapseButton(sectionId) {
    const collapsed = this.isCollapsed(sectionId);
    const actionLabel = collapsed ? "展开" : "折叠";
    return `<button type="button" class="btn btn-sm collapse-btn" data-app-action="toggle-section" data-id="${Utils.esc(sectionId)}" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${actionLabel}此区域">${actionLabel} ${collapsed ? '▾' : '▴'}</button>`;
  },
  sectionToggleTriangle(sectionId) {
    const collapsed = this.isCollapsed(sectionId);
    const actionLabel = collapsed ? "展开" : "收起";
    return `<button type="button" class="section-toggle-triangle" title="${actionLabel}" aria-label="${actionLabel}此区域" aria-expanded="${collapsed ? 'false' : 'true'}" data-collapsed="${collapsed ? '1' : '0'}" data-app-action="toggle-section" data-id="${Utils.esc(sectionId)}"></button>`;
  },
  toggleSection(sectionId) {
    this.toggleSectionState(sectionId);
    this.renderContent();
  },

  updateSelectPlaceholderState(root = document) {
    const scope = root || document;
    scope.querySelectorAll?.("select").forEach(select => {
      const selected = select.options[select.selectedIndex];
      const isPlaceholder = !select.value || selected?.value === "";
      select.classList.toggle("placeholder-select", !!isPlaceholder);
    });
  },

  renderEmpty(msg) {
    const content = document.getElementById("content");
    if (!content) return;
    content.replaceChildren(this.textEl("div", msg, "card empty"));
  },

  // ---- 任务操作菜单统一管理 ----
  closeTaskOpMenus(exceptEl = null, { restoreFocus = false } = {}) {
    document.querySelectorAll(".task-op-menu.open, .task-more-menu.open").forEach(menu => {
      if (exceptEl && menu === exceptEl) return;
      menu.classList.remove("open", "open-up");
      const trigger = menu.querySelector?.(".task-more-trigger");
      const panel = menu.querySelector?.(".task-more-panel");
      trigger?.setAttribute?.("aria-expanded", "false");
      panel?.setAttribute?.("aria-hidden", "true");
      if (restoreFocus) trigger?.focus?.();
    });
  },

  handleTaskOpMenuClick(menu) {
    const wasOpen = menu.classList.contains("open");
    this.closeTaskOpMenus();
    if (!wasOpen) {
      menu.classList.add("open");
      menu.querySelector?.(".task-more-trigger")?.setAttribute?.("aria-expanded", "true");
      menu.querySelector?.(".task-more-panel")?.setAttribute?.("aria-hidden", "false");
      this.positionTaskMoreMenu(menu);
    }
  },

  positionTaskMoreMenu(menu) {
    if (!menu || typeof menu.querySelector !== "function") return;
    menu.classList.remove("open-up");
    const panel = menu.querySelector(".task-more-panel");
    if (!panel || typeof panel.getBoundingClientRect !== "function") return;
    const menuRect = menu.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
    const gap = 8;
    const spaceBelow = viewportHeight - menuRect.bottom;
    const spaceAbove = menuRect.top;
    if (spaceBelow < panelRect.height + gap && spaceAbove > spaceBelow) {
      menu.classList.add("open-up");
    }
  }

});
