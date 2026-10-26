/* Test equipment warehouse: region/department groups and equipment cards. */
app.registerModule("devices", {
  invalidateDeviceWarehouse() {
    this._deviceWarehouseRequest = (this._deviceWarehouseRequest || 0) + 1;
    this._deviceWarehouse = null;
    this._deviceWarehouseLoading = false;
    this._deviceWarehouseError = "";
  },

  currentDeviceGroup() {
    return this._deviceWarehouse?.groups?.find(group => group.id === this.view.selectedDeviceGroupId) || null;
  },

  async loadDeviceWarehouse() {
    const request = this._deviceWarehouseRequest = (this._deviceWarehouseRequest || 0) + 1;
    this._deviceWarehouseLoading = true;
    this._deviceWarehouseError = "";
    if (this.viewModule() === "devices") this.renderDevices();
    try {
      const read = async () => {
        const res = await fetch("/api/device-warehouse", { cache: "no-store" });
        const result = await res.json();
        if (!res.ok || !result.ok) throw new Error(result.error || "设备仓库加载失败");
        return result.warehouse;
      };
      const apply = warehouse => {
        if (request !== this._deviceWarehouseRequest) return null;
        this._deviceWarehouse = warehouse;
        return warehouse;
      };
      if (typeof this.readCurrentServerData === "function") return await this.readCurrentServerData(read, () => request === this._deviceWarehouseRequest, apply);
      return apply(await read());
    } catch (error) {
      if (request !== this._deviceWarehouseRequest) return null;
      this._deviceWarehouseError = error.message;
      return null;
    } finally {
      if (request === this._deviceWarehouseRequest) {
        this._deviceWarehouseLoading = false;
        if (this.viewModule() === "devices") this.render();
      }
    }
  },

  renderDevices() {
    const content = document.getElementById("content");
    if (!content) return;
    if (!this._deviceWarehouse && !this._deviceWarehouseLoading && !this._deviceWarehouseError) {
      this.loadDeviceWarehouse();
      return;
    }
    const group = this.currentDeviceGroup();
    const groups = this._deviceWarehouse?.groups || [];
    const disabled = this._deviceWarehouseLoading || !!this._deviceWarehouseError;
    const header = `<div class="device-warehouse-head"><div><h2>${group ? Utils.esc(group.region + "－" + group.department) : "测试设备仓库"}</h2><p>${group ? "设备列表 · " + (group.devices || []).length + " 台设备" : "地域－部门 · " + groups.length + " 张卡片"}</p></div>
      <div class="device-warehouse-actions">${group ? '<button class="btn btn-outline" data-app-action="go" data-module="devices">返回地域－部门</button>' : ""}<button class="btn btn-outline" data-app-action="device-warehouse-refresh" ${this._deviceWarehouseLoading ? "disabled" : ""}>刷新列表</button></div></div>`;
    if (this._deviceWarehouseError) {
      this.replaceHtml(content, `<section class="device-warehouse">${header}<div class="card device-warehouse-message" role="alert">${Utils.esc(this._deviceWarehouseError)}，请点击刷新列表重试。</div></section>`);
      return;
    }
    if (!this._deviceWarehouse) {
      this.replaceHtml(content, `<section class="device-warehouse">${header}<p role="status">正在加载设备仓库…</p></section>`);
      return;
    }
    const cards = groups.map(item => `<article class="card device-group-card">
      <div class="device-group-heading"><h3>${Utils.esc(item.region)}－${Utils.esc(item.department)}</h3><button class="btn btn-sm btn-outline" data-app-action="device-group-edit" data-id="${Utils.esc(item.id)}" aria-label="编辑 ${Utils.esc(item.region)}－${Utils.esc(item.department)}" ${disabled ? "disabled" : ""}>编辑</button></div>
      <dl><div><dt>地域</dt><dd>${Utils.esc(item.region)}</dd></div><div><dt>部门</dt><dd>${Utils.esc(item.department)}</dd></div></dl>
      <button class="btn device-group-enter" data-app-action="device-group-open" data-id="${Utils.esc(item.id)}">进入设备列表 <span aria-hidden="true">→</span></button>
    </article>`).join("");
    const body = group
      ? `<div class="grid device-card-grid">${(group.devices || []).map(device => this.deviceCardHtml(device, disabled)).join("")}
          <button type="button" class="card add-card device-add-card" data-app-action="device-add" ${disabled ? "disabled" : ""}><span class="add-card-plus" aria-hidden="true">+</span><span class="add-card-label">新增设备</span></button></div>`
      : `<div class="device-group-grid">${cards}<button class="card add-card device-group-add" data-app-action="device-group-add" ${disabled ? "disabled" : ""}><span class="device-group-plus" aria-hidden="true">＋</span><strong>新增地域－部门</strong><span>填写地域和部门，建立设备分组</span></button></div>`;
    this.replaceHtml(content, `<section class="device-warehouse">${header}${body}</section>`);
  },

  deviceStatusHtml(status = "闲置") {
    const tones = { "闲置": "idle", "已预约": "reserved", "使用中": "active", "阻塞中": "blocked", "维护中": "maintenance", "停用": "inactive" };
    return `<span class="device-status ${tones[status] || "inactive"}">${Utils.esc(status)}</span>`;
  },

  deviceBadgesHtml(device) {
    return `<span class="device-badges">${this.deviceStatusHtml(device.usageStatus || "闲置")}${device.status && device.status !== "闲置" ? this.deviceStatusHtml(device.status) : ""}${device.hasFault ? '<span class="device-status fault">故障</span>' : ""}</span>`;
  },

  deviceCardHtml(device, disabled = false) {
    return `<article class="card device-entry-card">
      <div class="device-card-heading"><h3>${Utils.esc(device.name)}</h3><button type="button" class="sample-card-edit-btn" data-app-action="device-edit" data-id="${Utils.esc(device.id)}" title="编辑设备" aria-label="编辑设备 ${Utils.esc(device.name)}" ${disabled ? "disabled" : ""}>✎</button></div>
      <dl class="device-card-meta">${[["编号", device.code], ["型号", device.model], ["位置", device.location], ["负责人", device.owner]].map(([label, value]) => `<div><dt>${label}</dt><dd title="${Utils.esc(value || "")}">${Utils.esc(value || "—")}</dd></div>`).join("")}</dl>
      <div class="device-card-footer">${this.deviceBadgesHtml(device)}<button type="button" class="btn device-card-open" data-app-action="device-open" data-id="${Utils.esc(device.id)}" aria-label="查看设备 ${Utils.esc(device.name)}">设备详情 <span aria-hidden="true">▶</span></button></div>
    </article>`;
  },

  openDevice(id) {
    const group = this.currentDeviceGroup();
    const device = group?.devices?.find(item => item.id === id);
    if (!device) return;
    this.showDeviceDetail(device, group);
  },

  findWarehouseDevice(id, warehouse = this._deviceWarehouse) {
    for (const group of warehouse?.groups || []) {
      const device = (group.devices || []).find(item => item.id === id);
      if (device) return { device, group };
    }
    return null;
  },

  showDeviceDetail(device, group = {}, notice = "", snapshotOnly = false) {
    const references = [...(device.currentTasks || []), ...(device.reservations || [])];
    const taskRows = references.map(ref => `<li><strong>${Utils.esc([ref.projectName, ref.stageName, ref.testItem || ref.taskName || ref.taskId].filter(Boolean).join(" / "))}</strong><span>${Utils.esc([ref.status || ref.flowStatus, ref.planStartDate && ref.planEndDate ? `${ref.planStartDate} ～ ${ref.planEndDate}` : ""].filter(Boolean).join(" · "))}</span></li>`).join("");
    this.showModal(`设备详情 · ${device.name || device.code || device.id}`, `<div class="device-detail">
      ${notice ? `<p class="device-reference-notice" role="status">${Utils.esc(notice)}</p>` : ""}
      ${snapshotOnly ? "" : `<div class="device-detail-status">${this.deviceBadgesHtml(device)}</div>`}
      <dl>${[["设备编号", device.code], ["设备名称", device.name], ["型号", device.model], ["制造商", device.manufacturer], ["地域－部门", [group.region, group.department].filter(Boolean).join("－")], ["存放位置", device.location], ["负责人", device.owner], ["备注", device.notes]].map(([label, value]) => `<div><dt>${label}</dt><dd>${Utils.esc(value || "—")}</dd></div>`).join("")}</dl>
      ${device.hasFault && device.faultNote ? `<div class="device-fault-note"><strong>故障说明</strong><p>${Utils.esc(device.faultNote)}</p></div>` : ""}
      ${taskRows ? `<section class="device-task-references"><h3>关联任务</h3><ul>${taskRows}</ul></section>` : ""}
      </div>`, null, "关闭", { hideCancel: true, className: "device-detail-modal" });
  },

  async openDeviceReference(id, snapshot = null) {
    if (!id) return;
    const saved = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot : null;
    if (saved?.external === true) {
      this.showDeviceDetail({ ...saved, id }, saved, "来源平台的设备快照，仅供查阅。", true);
      return;
    }
    const request = this.beginDialogRequest?.();
    let warehouse = null, failure = "";
    try {
      const read = async () => {
        const response = await fetch("/api/device-warehouse", { cache: "no-store" });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || "设备仓库加载失败");
        return result.warehouse;
      };
      warehouse = typeof this.readCurrentServerData === "function" ? await this.readCurrentServerData(read, () => !request || this.isDialogRequestCurrent(request)) : await read();
      if (!warehouse) failure = "设备数据已更新，请重试。";
    } catch (error) { failure = error.message || "设备仓库加载失败"; }
    if (request && !this.isDialogRequestCurrent(request)) return;
    const found = this.findWarehouseDevice(id, warehouse);
    if (found) this.showDeviceDetail(found.device, found.group);
    else if (saved) this.showDeviceDetail({ ...saved, id }, saved, failure ? "暂时无法读取设备仓库，以下为记录保存时的设备快照。" : "设备当前档案已不存在，以下为记录保存时的设备快照。", true);
    else Utils.toast(failure || "设备档案不存在，且没有可用的历史快照。");
  },

  applyDeviceWarehouseSave(result) {
    if (result.affected && Number.isInteger(result.previousRevision) && this.serverRevision === result.previousRevision && typeof this.acceptMutationResult === "function") {
      // Warehouse edits can affect tasks whose stages have never been loaded.
      // Acknowledge only hydrated tasks, otherwise the baseline alone would
      // create their stages and falsely report an unsaved project edit.
      const tasks = (result.affected.tasks || []).filter(task =>
        this.data?.projects?.find(project => project.id === task.projectId)?.stages?.some(stage => stage.id === task.stageId));
      this.acceptMutationResult({}, { ...result, affected: { ...result.affected, tasks } });
    }
    if (result.affected) {
      const sampleIds = result.affected.sampleIds || (result.affected.samples || []).map(sample => sample.id);
      this.invalidatePagedCaches?.();
      this.invalidateSampleHistoryCache?.(sampleIds);
      sampleIds.forEach(id => {
        const sample = this.findSample?.(id)?.sample;
        if (sample) {
          sample.eventsLoaded = false;
          this.syncHydratedSamplePatchBaseline?.(id, { eventsLoaded: false });
        }
      });
    }
    // Invalidate any list read that started before this successful save.
    this._deviceWarehouseRequest = (this._deviceWarehouseRequest || 0) + 1;
    this._deviceWarehouseLoading = false;
    this._deviceWarehouseError = "";
    this._deviceWarehouse = result.warehouse;
    if (Number.isInteger(result.previousRevision) && this.serverRevision === result.previousRevision) {
      this.serverRevision = result.revision;
      this.serverUpdatedAt = result.updated_at;
      this.updateServerStatus?.("已保存");
    }
    if (this.viewModule() === "devices") this.render();
  },

  async saveDeviceWarehousePayload(payload) {
    let release = null;
    try {
      if (typeof this.prepareBeforeDirectMutation === "function" && !await this.prepareBeforeDirectMutation("设备保存前同步")) throw new Error("请先完成当前编辑再保存设备。");
      if (typeof this.beginServerMutation === "function") {
        release = await this.beginServerMutation();
        if (!release) throw new Error("平台数据已更新，请重新打开设备编辑。");
      }
      const response = await fetch("/api/device-warehouse", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "设备保存失败，请重试");
      this.applyDeviceWarehouseSave(result);
      return result;
    } finally { release?.(); }
  },

  editDevice(id = "") {
    const group = this.currentDeviceGroup();
    if (!group || this._deviceWarehouseLoading || this._deviceWarehouseError) return;
    const existing = group.devices?.find(item => item.id === id);
    if (id && !existing) return;
    const deviceId = existing?.id || Utils.id("device_");
    const expectedRevision = this._deviceWarehouse.revision;
    const fields = [["name", "设备名称", 100, "例如：恒温恒湿试验箱"], ["code", "设备编号", 80, "填写唯一设备编号"], ["model", "型号", 100, "填写设备型号"], ["manufacturer", "制造商", 100, "填写制造商"], ["location", "存放位置", 120, "例如：D1B 一楼实验室"], ["owner", "负责人", 80, "填写负责人"]];
    this.showModal(existing ? "编辑设备" : "新增设备", `<p class="device-form-group">${Utils.esc(group.region)}－${Utils.esc(group.department)}</p><div class="device-form-grid">
      ${fields.map(([key, label, limit, placeholder]) => `<div class="form-group"><label for="deviceField_${key}">${label}${["name", "code"].includes(key) ? ' <span class="device-required">*</span>' : ""}</label><input id="deviceField_${key}" maxlength="${limit}" ${["name", "code"].includes(key) ? "required" : ""} placeholder="${placeholder}" value="${Utils.esc(existing?.[key] || "")}"></div>`).join("")}
      <div class="form-group"><label for="deviceField_status">设备管理状态</label><select id="deviceField_status">${["闲置", "维护中", "停用", ...(existing?.status === "使用中" ? ["使用中"] : [])].map(status => `<option ${status === (existing?.status || "闲置") ? "selected" : ""}>${status}</option>`).join("")}</select><small>预约、使用和阻塞状态由任务自动更新。</small></div>
      <div class="form-group"><label class="device-fault-toggle"><input type="checkbox" id="deviceField_hasFault" ${existing?.hasFault ? "checked" : ""}>设备存在故障</label></div>
      <div class="form-group device-form-notes"><label for="deviceField_faultNote">故障说明</label><textarea id="deviceField_faultNote" rows="2" maxlength="2000" placeholder="描述故障现象或处理情况">${Utils.esc(existing?.faultNote || "")}</textarea><small>标记故障后，正在使用此设备的任务将进入阻塞。修复后取消故障标记，再到任务中恢复测试；任务不会自动继续。</small></div>
      <div class="form-group device-form-notes"><label for="deviceField_notes">备注</label><textarea id="deviceField_notes" rows="3" maxlength="2000" placeholder="可填写使用说明或补充信息">${Utils.esc(existing?.notes || "")}</textarea></div>
      <p class="device-group-error device-form-notes" id="deviceFormError" role="alert"></p></div>`, async () => {
      this.clearFieldValidationMarks();
      const device = { id: deviceId };
      for (const [key, label, limit] of fields) {
        const input = document.getElementById(`deviceField_${key}`);
        device[key] = input.value.trim();
        if ((["name", "code"].includes(key) && !device[key]) || device[key].length > limit) {
          this.markFieldInvalid(input, `请填写${label}（最多 ${limit} 个字符）`);
          return true;
        }
      }
      device.status = document.getElementById("deviceField_status").value;
      device.hasFault = !!document.getElementById("deviceField_hasFault")?.checked;
      device.faultNote = document.getElementById("deviceField_faultNote")?.value.trim() || "";
      device.notes = document.getElementById("deviceField_notes").value.trim();
      const errorEl = document.getElementById("deviceFormError");
      errorEl.textContent = "";
      try {
        await this.saveDeviceWarehousePayload({ expectedRevision, groupId: group.id, device });
        return false;
      } catch (error) {
        errorEl.textContent = error.message;
        return true;
      }
    }, "保存", { className: "device-detail-modal" });
  },

  openDeviceGroup(id) {
    if (!this._deviceWarehouse?.groups?.some(group => group.id === id)) return;
    this.view.selectedDeviceGroupId = id;
    this.render();
  },

  editDeviceGroup(id = "") {
    if (!this._deviceWarehouse || this._deviceWarehouseLoading || this._deviceWarehouseError) return;
    const existing = this._deviceWarehouse.groups.find(group => group.id === id);
    if (id && !existing) return;
    const groupId = existing?.id || Utils.id("device_group_");
    const expectedRevision = this._deviceWarehouse.revision;
    this.showModal(existing ? "编辑地域－部门" : "新增地域－部门", `
      <div class="device-group-form">
        <div class="form-group"><label for="deviceRegion">地域</label><input id="deviceRegion" maxlength="80" required placeholder="例如：深圳" value="${Utils.esc(existing?.region || "")}"></div>
        <div class="form-group"><label for="deviceDepartment">部门</label><input id="deviceDepartment" maxlength="80" required placeholder="例如：可靠性实验室" value="${Utils.esc(existing?.department || "")}"></div>
        <p class="device-group-error" id="deviceGroupError" role="alert"></p>
      </div>`, async () => {
      this.clearFieldValidationMarks();
      const regionEl = document.getElementById("deviceRegion");
      const departmentEl = document.getElementById("deviceDepartment");
      const region = regionEl.value.trim(), department = departmentEl.value.trim();
      if (!region || region.length > 80) { this.markFieldInvalid(regionEl, "请填写地域（1–80 个字符）"); return true; }
      if (!department || department.length > 80) { this.markFieldInvalid(departmentEl, "请填写部门（1–80 个字符）"); return true; }
      const errorEl = document.getElementById("deviceGroupError");
      errorEl.textContent = "";
      try {
        await this.saveDeviceWarehousePayload({ expectedRevision, group: { id: groupId, region, department } });
        return false;
      } catch (error) {
        errorEl.textContent = error.message;
        return true;
      }
    }, "保存", { className: "device-group-modal" });
  }
});
