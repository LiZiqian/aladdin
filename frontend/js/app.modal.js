/* ========================================
   数字治理平台 V7 - 弹窗模块
   ======================================== */

app.registerModule("app.modal", {

  beginDialogRequest() {
    return {
      sequence: this._dialogRequestSequence = (this._dialogRequestSequence || 0) + 1,
      modalId: this._currentModalId || null,
      confirmId: this._currentConfirmId || null,
      viewKey: JSON.stringify(this.view || {}),
      epoch: this._dataSnapshotEpoch || 0,
    };
  },

  isDialogRequestCurrent(request) {
    return !!request && request.sequence === this._dialogRequestSequence
      && request.modalId === (this._currentModalId || null)
      && request.confirmId === (this._currentConfirmId || null)
      && request.viewKey === JSON.stringify(this.view || {})
      && request.epoch === (this._dataSnapshotEpoch || 0);
  },

  dialogFocusableElements(root) {
    if (!root) return [];
    return Array.from(root.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(el => !el.hidden && el.getAttribute("aria-hidden") !== "true" && el.getClientRects().length > 0);
  },

  focusDialog(root, preferred = null) {
    if (!root) return;
    const target = preferred && preferred.isConnected && !preferred.disabled
      ? preferred
      : root.querySelector("[autofocus]") || root;
    if (!target.hasAttribute("tabindex") && target === root) target.setAttribute("tabindex", "-1");
    setTimeout(() => target?.focus?.({ preventScroll: true }), 0);
  },

  trapDialogTab(event, root) {
    if (event.key !== "Tab" || !root) return;
    const focusable = this.dialogFocusableElements(root);
    if (!focusable.length) {
      event.preventDefault();
      this.focusDialog(root);
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !root.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !root.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  },

  bindDialogKeyboardEvents() {
    if (this._dialogKeyboardEventsBound) return;
    this._dialogKeyboardEventsBound = true;
    document.addEventListener("keydown", event => {
      if (event.defaultPrevented) return;
      const preview = document.querySelector(".sample-photo-preview-mask");
      if (preview) {
        if (event.key === "Escape") {
          event.preventDefault();
          preview.remove();
          return;
        }
        this.trapDialogTab(event, preview);
        return;
      }
      const confirmMask = document.getElementById("confirmMask");
      if (confirmMask?.style.display === "flex") {
        const box = confirmMask.querySelector(".confirm-box");
        if (event.key === "Escape") {
          event.preventDefault();
          this.closeConfirm();
          return;
        }
        this.trapDialogTab(event, box);
        return;
      }
      const modalMask = document.getElementById("modalMask");
      if (modalMask?.style.display !== "flex") return;
      const modal = modalMask.querySelector(".modal");
      if (event.key === "Escape" && !this._modalBusy) {
        event.preventDefault();
        this.requestModalClose();
        return;
      }
      this.trapDialogTab(event, modal);
    });
  },

  // ---- 模态框 ----
  showModal(title, bodyHtml, onOk, okText = "确认", options = {}) {
    this._dialogRequestSequence = (this._dialogRequestSequence || 0) + 1;
    const modalMask = document.getElementById("modalMask");
    const modalWasOpen = modalMask?.style.display === "flex";
    this.disposeSample3dPreviews?.();
    if (!this._restoringModal && !modalWasOpen) this._modalReturnFocus = document.activeElement;
    // 模态框堆栈：当前已显示时，保存当前状态
    if (!this._restoringModal && modalWasOpen) {
      const modalEl = document.querySelector(".modal");
      const modalBody = document.getElementById("modalBody");
      const modalTitle = document.getElementById("modalTitle");
      const footer = document.querySelector(".modal-footer");
      this._modalStack.push({
        modalId: this._currentModalId,
        title: modalTitle.innerText,
        titleNodes: Array.from(modalTitle.childNodes || []),
        bodyNodes: Array.from(modalBody.childNodes || []),
        bodyScrollTop: modalBody.scrollTop || 0,
        footerOrder: Array.from(footer?.children || []).map(node => {
          if (node.id === "modalCancel") return { kind: "cancel" };
          if (node.id === "modalOk") return { kind: "ok" };
          return { kind: "node", node };
        }),
        onOk: this._currentModalOnOk,
        onCancel: this._currentModalOnCancel,
        okText: document.getElementById("modalOk").innerText,
        okClass: document.getElementById("modalOk").className,
        hideCancel: document.getElementById("modalCancel").style.display === "none",
        cancelText: document.getElementById("modalCancel").innerText,
        headerHint: (document.getElementById("modalHeaderHint")?.innerText || ""),
        className: modalEl ? modalEl.className.replace(/^modal\s*/, "") : "",
        focusedElement: document.activeElement
      });
    }
    this._restoringModal = false;
    this._currentModalOnOk = onOk;
    this._currentModalOnCancel = typeof options.onCancel === "function" ? options.onCancel : null;
    const modalId = options.modalId || `modal_${++this._modalSequence}`;
    this._currentModalId = modalId;
    this._modalBusy = false;

    const modal = document.querySelector(".modal");
    if (modal) {
      modal.className = `modal${options.className ? " " + options.className : ""}`;
      modal.setAttribute("aria-busy", "false");
    }
    const modalTitle = document.getElementById("modalTitle");
    if (options.titleNodes) modalTitle.replaceChildren(...options.titleNodes);
    else modalTitle.innerText = title;
    const hint = document.getElementById("modalHeaderHint");
    if (hint) {
      hint.innerText = options.headerHint || "";
      hint.style.display = options.headerHint ? "" : "none";
    }
    const modalBody = document.getElementById("modalBody");
    modalBody.removeAttribute("inert");
    if (options.bodyNodes) modalBody.replaceChildren(...options.bodyNodes);
    else this.replaceHtml(modalBody, bodyHtml);
    const footer = document.querySelector(".modal-footer");
    if (footer) {
      footer.removeAttribute("inert");
      Array.from(footer.children).forEach(node => {
        if (node.id !== "modalCancel" && node.id !== "modalOk") node.remove();
      });
      const baseCancel = document.getElementById("modalCancel");
      const baseOk = document.getElementById("modalOk");
      if (baseCancel && baseOk) footer.append(baseCancel, baseOk);
    }
    const cancel = this.resetEventTarget(document.getElementById("modalCancel"));
    if (cancel) {
      // 取消按钮由当前 modal 实例独立管理，避免 document 级 data-app-action 再次关闭父弹窗。
      cancel.removeAttribute("data-app-action");
      cancel.disabled = false;
      cancel.style.display = options.hideCancel ? "none" : "";
      cancel.innerText = options.cancelText || "取消";
      cancel.className = "btn btn-outline";
      cancel.addEventListener("click", () => {
        if (!cancel.disabled) return this.requestModalClose(modalId);
      });
    }
    const ok = this.resetEventTarget(document.getElementById("modalOk"));
    if (!ok) { console.error("modalOk not found in DOM"); return; }
    ok.disabled = false;
    ok.className = options.okClass || "btn";
    ok.innerText = okText;
    ok.addEventListener("click", async () => {
      if (ok.disabled || this._modalBusy || this._currentModalId !== modalId) return;
      try {
        const keepOpen = onOk && onOk();
        if (keepOpen && typeof keepOpen.then === "function") {
          this.setModalBusy(modalId, true);
          const resolved = await keepOpen;
          if (this._currentModalId !== modalId) return;
          this.setModalBusy(modalId, false);
          if (!resolved) this.closeModal(modalId);
          return;
        }
        if (!keepOpen) this.closeModal(modalId);
      } catch (e) {
        if (this._currentModalId === modalId) this.setModalBusy(modalId, false);
        console.error("[showModal] onOk 异常：", e);
        alert("操作失败：" + (e.message || e));
      }
    });
    if (footer && options.footerOrder) {
      const restoredOrder = options.footerOrder.map(item => {
        if (item.kind === "cancel") return cancel;
        if (item.kind === "ok") return ok;
        return item.node || null;
      }).filter(Boolean);
      if (!restoredOrder.includes(cancel)) restoredOrder.push(cancel);
      if (!restoredOrder.includes(ok)) restoredOrder.push(ok);
      footer.replaceChildren(...restoredOrder);
    } else if (footer && options.footerExtraNodes) {
      footer.prepend(...options.footerExtraNodes.filter(Boolean));
    }
    modalMask.style.display = "flex";
    modalMask.setAttribute("aria-hidden", "false");
    modalBody.scrollTop = Number(options.bodyScrollTop || 0);
    this.updateSelectPlaceholderState(document.getElementById("modalBody"));
    this.bindDialogKeyboardEvents();
    this.focusDialog(modal);
    return modalId;
  },

  setModalBusy(modalId, busy) {
    if (this._currentModalId !== modalId) return false;
    this._modalBusy = !!busy;
    const modal = document.querySelector(".modal");
    const body = document.getElementById("modalBody");
    const footer = document.querySelector(".modal-footer");
    if (modal) modal.setAttribute("aria-busy", busy ? "true" : "false");
    if (body) {
      if (busy) body.setAttribute("inert", "");
      else body.removeAttribute("inert");
    }
    if (footer) {
      if (busy) footer.setAttribute("inert", "");
      else footer.removeAttribute("inert");
    }
    return true;
  },

  showConfirm(message, onOk, options = {}) {
    this._dialogRequestSequence = (this._dialogRequestSequence || 0) + 1;
    const mask = document.getElementById("confirmMask");
    const box = mask?.querySelector(".confirm-box");
    const title = document.getElementById("confirmTitle");
    const msg = document.getElementById("confirmMessage");
    const desc = document.getElementById("confirmDesc");
    const cancel = document.getElementById("confirmCancel");
    const ok = document.getElementById("confirmOk");
    if (!mask || !title || !msg || !cancel || !ok) {
      console.warn("Confirm dialog is not available:", message);
      return;
    }
    this._confirmReturnFocus = document.activeElement;
    const confirmId = (this._confirmSequence || 0) + 1;
    this._confirmSequence = confirmId;
    this._currentConfirmId = confirmId;
    this._confirmBusy = false;
    box?.setAttribute("aria-busy", "false");
    if (box) box.className = `confirm-box${options.className ? " " + options.className : ""}`;
    title.innerText = options.title || "确认操作";
    msg.innerText = message || "";
    if (desc) {
      desc.innerText = options.description || "";
      desc.style.display = options.description ? "" : "none";
    }
    cancel.style.display = options.hideCancel ? "none" : "";
    cancel.innerText = options.cancelText || "取消";
    ok.innerText = options.okText || "确认";
    ok.className = options.okClass || "btn";
    const boundCancel = this.resetEventTarget(cancel);
    const boundOk = this.resetEventTarget(ok);
    if (!boundCancel || !boundOk) return;
    boundCancel.disabled = false;
    boundOk.disabled = false;
    boundCancel.style.display = cancel.style.display;
    boundCancel.innerText = options.cancelText || "取消";
    boundCancel.addEventListener("click", () => this.closeConfirm(confirmId));
    boundOk.innerText = options.okText || "确认";
    boundOk.className = options.okClass || "btn";
    boundOk.addEventListener("click", async () => {
      if (boundOk.disabled || this._confirmBusy || this._currentConfirmId !== confirmId) return;
      this._confirmBusy = true;
      boundOk.disabled = true;
      boundCancel.disabled = true;
      box?.setAttribute("aria-busy", "true");
      try {
        const result = typeof onOk === "function" ? onOk() : null;
        if (result && typeof result.then === "function") await result;
        if (this._currentConfirmId === confirmId) {
          this._confirmBusy = false;
          this.closeConfirm(confirmId);
        }
      } catch (e) {
        console.error("[showConfirm] onOk 异常：", e);
        alert("操作失败：" + (e.message || e));
      } finally {
        if (this._currentConfirmId === confirmId) {
          this._confirmBusy = false;
          boundOk.disabled = false;
          boundCancel.disabled = false;
          box?.setAttribute("aria-busy", "false");
        }
      }
    });
    mask.style.display = "flex";
    mask.setAttribute("aria-hidden", "false");
    this.bindDialogKeyboardEvents();
    this.focusDialog(box, options.hideCancel ? boundOk : boundCancel);
  },

  showAlert(message, options = {}) {
    this.showConfirm(message, null, {
      title: options.title || "提示",
      okText: options.okText || "确定",
      okClass: options.okClass || "btn",
      hideCancel: true,
      className: "alert-box"
    });
  },

  closeConfirm(expectedConfirmId = null) {
    if (expectedConfirmId !== null && this._currentConfirmId !== expectedConfirmId) return false;
    if (this._confirmBusy) return false;
    const mask = document.getElementById("confirmMask");
    if (mask) {
      mask.style.display = "none";
      mask.setAttribute("aria-hidden", "true");
    }
    const box = mask?.querySelector(".confirm-box");
    if (box) {
      box.className = "confirm-box";
      box.setAttribute("aria-busy", "false");
    }
    this._currentConfirmId = null;
    const returnFocus = this._confirmReturnFocus;
    this._confirmReturnFocus = null;
    if (returnFocus?.isConnected) setTimeout(() => returnFocus.focus?.({ preventScroll: true }), 0);
    return true;
  },

  async requestModalClose(expectedModalId = null) {
    const modalId = expectedModalId || this._currentModalId;
    if (!modalId || this._currentModalId !== modalId || this._modalBusy) return false;
    try {
      let keepOpen = this._currentModalOnCancel ? this._currentModalOnCancel() : false;
      if (keepOpen && typeof keepOpen.then === "function") {
        this.setModalBusy(modalId, true);
        keepOpen = await keepOpen;
        if (this._currentModalId !== modalId) return false;
        this.setModalBusy(modalId, false);
      }
      return keepOpen ? false : this.closeModal(modalId);
    } catch (e) {
      if (this._currentModalId === modalId) this.setModalBusy(modalId, false);
      console.error("[showModal] onCancel 异常：", e);
      alert("操作失败：" + (e.message || e));
      return false;
    }
  },

  closeModal(expectedModalId = null) {
    if (expectedModalId && this._currentModalId !== expectedModalId) return false;
    if (!expectedModalId && this._modalBusy) return false;
    this.disposeSample3dPreviews?.();
    if (this._currentModalId) this.setModalBusy(this._currentModalId, false);
    // 模态框堆栈：有上一级则恢复
    if (this._modalStack.length > 0) {
      const prev = this._modalStack.pop();
      this._restoringModal = true;
      this.showModal(prev.title, "", prev.onOk, prev.okText, {
        modalId: prev.modalId,
        okClass: prev.okClass || "btn",
        hideCancel: prev.hideCancel,
        cancelText: prev.cancelText,
        onCancel: prev.onCancel,
        headerHint: prev.headerHint || "",
        className: prev.className || "",
        titleNodes: prev.titleNodes || [],
        bodyNodes: prev.bodyNodes || [],
        bodyScrollTop: prev.bodyScrollTop || 0,
        footerOrder: prev.footerOrder || []
      });
      this.focusDialog(document.querySelector(".modal"), prev.focusedElement || null);
      return true;
    }
    const modalMask = document.getElementById("modalMask");
    modalMask.style.display = "none";
    modalMask.setAttribute("aria-hidden", "true");
    const modal = document.querySelector(".modal");
    if (modal) modal.className = "modal";
    const hint = document.getElementById("modalHeaderHint");
    if (hint) {
      hint.innerText = "";
      hint.style.display = "none";
    }
    this._currentModalId = null;
    this._currentModalOnOk = null;
    this._currentModalOnCancel = null;
    this._modalBusy = false;
    const returnFocus = this._modalReturnFocus;
    this._modalReturnFocus = null;
    if (returnFocus?.isConnected) setTimeout(() => returnFocus.focus?.({ preventScroll: true }), 0);
    return true;
  },

  // ---- 内联表单校验工具 ----
  // 清除当前模态框中所有校验标记
  clearFieldValidationMarks() {
    const modal = document.querySelector(".modal");
    if (!modal) return;
    modal.querySelectorAll(".is-invalid").forEach(el => el.classList.remove("is-invalid"));
    modal.querySelectorAll(".field-error").forEach(el => el.remove());
  },

  fieldErrorNode(message) {
    const node = document.createElement("div");
    node.className = "field-error";
    node.textContent = String(message || "");
    return node;
  },

  appendFieldError(container, message) {
    if (!container || !message || container.querySelector(".field-error")) return null;
    const node = this.fieldErrorNode(message);
    container.append(node);
    return node;
  },

  insertFieldErrorAfter(anchor, message) {
    const parent = anchor?.parentElement || null;
    if (!parent || !message || parent.querySelector(".field-error")) return null;
    const node = this.fieldErrorNode(message);
    if (typeof anchor.after === "function") anchor.after(node);
    else parent.insertBefore(node, anchor.nextSibling || null);
    return node;
  },

  // 将指定元素标记为校验失败，在其所属 .form-group 中显示错误信息
  markFieldInvalid(el, message) {
    if (!el) return;
    this.revealInvalidFieldPanel?.(el);
    el.classList.add("is-invalid");
    const group = el.closest(".form-group") || el.closest(".form-row") || el.parentElement;
    this.appendFieldError(group, message);
    const first = document.querySelector(".modal .is-invalid");
    first?.scrollIntoView({ block: "center", behavior: "smooth" });
  },

  revealInvalidFieldPanel(el) {
    const panel = el?.closest?.(".task-config-panel");
    if (!panel || panel.classList.contains("active")) return;
    document.querySelectorAll(".task-config-panel").forEach(item => item.classList.toggle("active", item === panel));
    const value = ({ tcPanelSample: "sample", tcPanelPlan: "plan", tcPanelDevice: "device" })[panel.id] || "";
    if (!value) return;
    document.querySelectorAll(".task-config-nav-card").forEach(item => {
      item.classList.toggle("active", item.dataset.value === value);
    });
  },

  // ---- 危险确认弹窗（DELETE 关键词二次验证） ----
  showDangerConfirm(descHtml, onConfirm, options = {}) {
    const confirmCode = options.confirmCode || "DELETE";
    const actionLabel = options.actionLabel || "删除";
    const body = `
      <div class="delete-confirm">
        ${descHtml}
        <label>请输入 <strong>${Utils.esc(confirmCode)}</strong> 确认${Utils.esc(actionLabel)}：</label>
        <input id="deleteKeywordInput" autocomplete="off" autofocus>
        <div id="deleteKeywordError" class="delete-confirm-error" style="display:none">请输入 ${Utils.esc(confirmCode)} 后才能继续。</div>
      </div>
    `;
    this.showModal(options.title || "危险操作确认", body, () => {
      const input = document.getElementById("deleteKeywordInput");
      const error = document.getElementById("deleteKeywordError");
      if ((input?.value || "") !== confirmCode) {
        if (error) error.style.display = "block";
        input?.focus();
        return true;
      }
      return onConfirm?.();
    }, options.okText || "确认", {
      okClass: options.okClass || "btn btn-danger",
      hideCancel: false,
      cancelText: options.cancelText || "取消",
      className: options.className || ""
    });
    setTimeout(() => document.getElementById("deleteKeywordInput")?.focus(), 60);
  }

});
