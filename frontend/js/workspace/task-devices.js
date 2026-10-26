/* Equipment selections stay on the modal DOM node until the task is saved.
 * This also preserves the draft when a nested device detail modal is opened. */
app.registerModule("workspace.taskDevices", {
  taskDeviceConfigPanelHtml(task) {
    return `<div id="tcDevicePick" class="task-device-picker" data-task-id="${Utils.esc(task?.id || "")}" data-device-ids="${Utils.esc(JSON.stringify(task?.deviceIds || []))}" data-device-snapshots="${Utils.esc(JSON.stringify(task?.deviceSnapshots || {}))}">
      <p class="path">可选择多台测试设备，也可不配置设备。预约冲突按计划日期检查，使用中或阻塞中的设备不能被其他任务占用。</p>
      <div class="task-device-toolbar"><label>地域－部门<select class="task-device-group" data-app-action="task-device-filter" data-app-events="change"><option value="">全部地域－部门</option></select></label>
        <label>查找设备<input class="task-device-search" type="search" placeholder="名称、编号、型号、地域或部门" data-app-action="task-device-filter" data-app-events="input"></label>
        <button type="button" class="btn btn-sm btn-outline" data-app-action="task-device-refresh">刷新设备</button></div>
      <div class="task-device-status" role="status"></div><div class="task-device-selected"></div><div class="task-device-results"></div>
    </div>`;
  },

  taskDevicePickerState(root = document.getElementById("tcDevicePick")) {
    if (!root) return null;
    if (!root._taskDevicePicker) {
      let ids = [], snapshots = {};
      try { ids = JSON.parse(root.dataset.deviceIds || "[]"); snapshots = JSON.parse(root.dataset.deviceSnapshots || "{}"); } catch (_) { /* An empty draft is safe for malformed local markup. */ }
      root._taskDevicePicker = { selected: new Set(Array.isArray(ids) ? ids : []), snapshots, warehouse: null, loading: false, error: "", request: 0 };
    }
    return root._taskDevicePicker;
  },

  getSelectedTaskDeviceIds() {
    const state = this.taskDevicePickerState();
    return state ? [...state.selected] : null;
  },

  async refreshTaskDevicePicker(root = document.getElementById("tcDevicePick")) {
    const state = this.taskDevicePickerState(root);
    if (!state) return;
    const request = ++state.request;
    state.loading = true; state.error = "";
    this.renderTaskDevicePicker(root);
    try {
      const read = async () => {
        const response = await fetch("/api/device-warehouse", { cache: "no-store" });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || "设备仓库加载失败");
        return result.warehouse;
      };
      const warehouse = typeof this.readCurrentServerData === "function" ? await this.readCurrentServerData(read, () => request === state.request) : await read();
      if (request !== state.request) return;
      if (!warehouse) throw new Error("设备数据已变化，请刷新重试");
      state.warehouse = warehouse;
      const groupSelect = root.querySelector(".task-device-group");
      const selectedGroup = groupSelect.value;
      this.replaceHtml(groupSelect, '<option value="">全部地域－部门</option>' + (state.warehouse?.groups || []).map(group =>
        `<option value="${Utils.esc(group.id)}">${Utils.esc(group.region)}－${Utils.esc(group.department)}</option>`).join(""));
      groupSelect.value = selectedGroup;
    } catch (error) {
      if (request !== state.request) return;
      state.error = error.message || "设备仓库加载失败";
    } finally {
      if (request === state.request) { state.loading = false; this.renderTaskDevicePicker(root); }
    }
  },

  taskDeviceRows(warehouse) {
    return (warehouse?.groups || []).flatMap(group => (group.devices || []).map(device => ({ device, group })));
  },

  taskDevicePickerRowHtml(row, selected, snapshot = null) {
    const device = row?.device || snapshot || {}, group = row?.group || device;
    const unavailable = !row || device.hasFault || (device.status && device.status !== "闲置");
    const disabled = !selected && unavailable;
    const usage = device.usageStatus || "闲置";
    const refs = [...(device.currentTasks || []), ...(device.reservations || [])];
    const related = refs.map(ref => [ref.projectName, ref.stageName, ref.testItem || ref.taskName || ref.taskId].filter(Boolean).join(" / ")).filter(Boolean);
    const detail = [device.code, device.model, [group.region, group.department].filter(Boolean).join("－")].filter(Boolean).join(" · ");
    return `<label class="task-device-row ${disabled ? "is-unavailable" : ""}"><input type="checkbox" data-app-action="task-device-select" data-app-events="change" data-device-id="${Utils.esc(device.id || "")}" ${selected ? "checked" : ""} ${disabled ? "disabled" : ""}>
      <span class="task-device-row-main"><strong>${Utils.esc(device.name || device.code || device.id || "设备档案不可用")}</strong><small>${Utils.esc(detail || "设备档案不可用，可取消关联")}</small>${related.length ? `<small class="task-device-use-hint">关联任务：${Utils.esc(related.join("；"))}</small>` : ""}</span>
      <span class="task-device-row-status">${row ? this.deviceStatusHtml(usage) + (device.status && device.status !== "闲置" ? this.deviceStatusHtml(device.status) : "") + (device.hasFault ? '<span class="device-status fault">故障</span>' : "") : '<span class="device-status inactive">档案缺失</span>'}</span>
    </label>`;
  },

  renderTaskDevicePicker(root = document.getElementById("tcDevicePick")) {
    const state = this.taskDevicePickerState(root);
    if (!state) return;
    const rows = this.taskDeviceRows(state.warehouse), lookup = new Map(rows.map(row => [row.device.id, row]));
    const selected = [...state.selected].map(id => this.taskDevicePickerRowHtml(lookup.get(id), true, { ...state.snapshots?.[id], id })).join("");
    this.replaceHtml(root.querySelector(".task-device-selected"), `<h4>已选设备 <span>${state.selected.size} 台</span></h4>${selected || '<p class="path">未配置测试设备</p>'}`);
    const groupId = root.querySelector(".task-device-group").value;
    const search = root.querySelector(".task-device-search").value.trim().toLocaleLowerCase();
    const filtered = rows.filter(({ device, group }) => !state.selected.has(device.id) && (!groupId || group.id === groupId)
      && (!search || [device.name, device.code, device.model, group.region, group.department].join(" ").toLocaleLowerCase().includes(search)));
    this.replaceHtml(root.querySelector(".task-device-results"), `<h4>可选设备</h4>${filtered.slice(0, 200).map(row => this.taskDevicePickerRowHtml(row, false)).join("") || (state.loading ? "" : '<p class="path">没有匹配的设备</p>')}${filtered.length > 200 ? '<p class="path">当前显示前 200 台，请筛选地域－部门或输入更具体的关键词。</p>' : ""}`);
    root.querySelector(".task-device-status").textContent = state.loading ? "正在加载设备仓库…" : state.error ? `加载失败：${state.error}。已有选择已保留，可点击刷新重试。` : "故障、维护中或停用设备不能新增到任务；已有预约的设备可选择，由服务器检查日期冲突。";
    const refresh = root.querySelector('[data-app-action="task-device-refresh"]');
    if (refresh) refresh.disabled = state.loading;
  },

  filterTaskDevicePicker(target) { this.renderTaskDevicePicker(target?.closest(".task-device-picker")); },

  selectTaskDevice(target) {
    const root = target?.closest(".task-device-picker"), state = this.taskDevicePickerState(root);
    if (!state || target.disabled) return;
    const id = target.dataset.deviceId;
    if (!id) return;
    if (target.checked) {
      const row = this.taskDeviceRows(state.warehouse).find(item => item.device.id === id);
      if (!row || row.device.hasFault || (row.device.status && row.device.status !== "闲置")) { target.checked = false; return; }
      state.selected.add(id);
    } else state.selected.delete(id);
    this.renderTaskDevicePicker(root);
  },
});
