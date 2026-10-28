/* CT models/videos and point-cloud files share one archive workflow. */
app.registerModule("samples.files", {
  sampleFileConfig(category) {
    return category === "pointcloud"
      ? { title: "点云数据", accept: ".ply,.pcd,.xyz,.pts,.txt", maxBytes: 75 * 1024 * 1024, limitLabel: "75 MB", hint: "支持 PLY、PCD、XYZ、PTS、TXT 点云文件，可在线 3D 查看并显示 RGB 颜色。" }
      : { title: "CT三维数据", accept: ".stl,.mp4,.webm,.mov,.m4v,.avi,.mkv", maxBytes: 1024 * 1024 * 1024, limitLabel: "1 GB", hint: "支持 STL 三维模型在线预览，以及 CT 切片视频（MP4、WebM、MOV、M4V、AVI、MKV）。STL 默认以流畅精细度显示，可切换为均衡或精细；原文件完整保存。" };
  },

  sampleFilesPanelHtml(sampleId, category, readonly, files = null, error = "") {
    const config = this.sampleFileConfig(category);
    const rows = (files || []).filter(file => category === "pointcloud" ? file.kind === "point_cloud" : file.kind === "ct_model" || file.kind === "ct_video");
    const action = (name, text, id = "") => `<button type="button" class="btn btn-sm btn-outline sample-file-control" data-app-action="sample-file-${name}" data-category="${category}" data-file-id="${Utils.esc(id)}"${name === "model-preview" ? ' aria-expanded="false"' : ""}>${text}</button>`;
    const esc = Utils.esc;
    return `<div class="sample-files-heading"><h3>${config.title}</h3>${readonly ? "" : action("upload", "添加文件")}</div>
      <p class="sample-files-hint">${config.hint}${readonly ? "" : ` 每个文件不超过 ${config.limitLabel}，可多选、分次添加。添加和删除立即保存。`}</p>
      ${category === "pointcloud" ? '<details class="sample-files-format-help"><summary>格式与列顺序说明</summary><p>PLY：ASCII、二进制（小端/大端）；PCD：ASCII、二进制、LZF 压缩。XYZ/TXT：每行 X Y Z，可追加强度 I、RGB 或 I R G B；以空格、制表符或逗号分隔，RGB 范围 0–255。PTS 首行为点数，其余每行格式同上。无颜色时按高度着色。预览最多显示 100 万个点，原文件完整保存。</p></details>' : ""}
      <div class="sample-files-status" role="status">${esc(error)}</div>
      ${error ? action("reload", "重新加载") : files === null ? '<p class="path">打开后加载文件列表</p>' : rows.length ? `<div class="sample-files-list">${rows.map(file => {
        const url = `/api/samples/${encodeURIComponent(sampleId)}/files/${encodeURIComponent(file.id)}`;
        const size = file.size < 1024 * 1024 ? `${Math.ceil(file.size / 1024)} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`;
        const format = String(file.name || "").split(".").pop().toLowerCase();
        const pointCloud = file.kind === "point_cloud";
        const model = file.kind === "ct_model" || pointCloud;
        const type = file.kind === "ct_video" ? "CT 视频" : file.kind === "ct_model" ? "STL 模型" : `${esc(format.toUpperCase())} 点云`;
        return `<article class="sample-file-card"><div class="sample-file-info"><strong title="${esc(file.name)}">${esc(file.name)}</strong><span>${type} · ${size}</span><small>${esc(file.uploadedAt || "")}</small></div>
          <div class="sample-file-actions">${model ? action("model-preview", "3D 预览", file.id) : file.kind === "ct_video" ? action("preview", "播放视频", file.id) : ""}<a class="btn btn-sm btn-outline" href="${esc(url)}?download=1" download="${esc(file.name)}">下载</a>${readonly ? "" : action("delete", "删除", file.id)}</div>
          ${file.kind === "ct_video" ? `<div class="sample-file-video" data-file-video="${esc(file.id)}" hidden><video controls playsinline preload="none" src="${esc(url)}" aria-label="${esc(file.name)}"></video><p class="sample-files-hint">若当前浏览器不支持此视频编码，可下载后播放。</p></div>` : model ? `<div class="sample-file-model" data-model-kind="${pointCloud ? "point_cloud" : "ct_model"}" data-model-format="${esc(format)}" data-model-url="${esc(url)}" data-model-name="${esc(file.name)}" hidden>
            <div class="sample-stl-toolbar"><span class="sample-stl-status" role="status" aria-live="polite"></span>${pointCloud ? `<div class="sample-point-controls">${action("point-smaller", "点缩小", file.id)}<output class="sample-point-size" aria-label="点大小">3 px</output>${action("point-larger", "点放大", file.id)}</div>` : `<div class="sample-stl-quality" role="group" aria-label="显示精细度"><span>精细度</span>${[["low", "流畅"], ["medium", "均衡"], ["high", "精细"]].map(([quality, label]) => `<button type="button" class="btn btn-sm btn-outline sample-file-control" data-app-action="sample-file-model-quality" data-category="${category}" data-quality="${quality}" aria-pressed="${quality === "low"}" disabled>${label}</button>`).join("")}</div>`}${action("model-reset", "复位视角", file.id)}</div>
            <div class="sample-stl-viewport"></div>
            <p class="sample-files-hint">拖动旋转 · 滚轮缩放 · 右键或 Shift + 拖动平移。聚焦模型后可用方向键旋转、+/− 缩放、Home 复位。${pointCloud ? "点云按原始坐标比例展示。" : "STL 不含单位，预览按模型比例展示。"}</p>
          </div>` : ""}</article>`;
      }).join("")}</div>` : '<div class="sample-files-empty">暂无文件</div>'}`;
  },

  async loadSampleArchiveFiles(shell, category) {
    const panel = shell?.querySelector(`[data-sample-archive-panel="${category}"]`);
    if (!panel || panel.dataset.busy === "1") return;
    this.disposeSample3dPreviews(panel);
    const request = String((Number(panel.dataset.request) || 0) + 1);
    panel.dataset.request = request;
    const sampleId = shell.dataset.sampleDetailId;
    const readonly = shell.dataset.readonly === "1";
    this.replaceHtml(panel, '<p class="path">正在加载文件…</p>');
    try {
      const response = await fetch(`/api/samples/${encodeURIComponent(sampleId)}/files`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
      if (panel.isConnected && panel.dataset.request === request) this.replaceHtml(panel, this.sampleFilesPanelHtml(sampleId, category, readonly, result.files));
    } catch (error) {
      if (panel.isConnected && panel.dataset.request === request) this.replaceHtml(panel, this.sampleFilesPanelHtml(sampleId, category, readonly, null, `文件加载失败：${error.message}`));
    }
  },

  // Keep one GPU context alive. Dispose before a panel is replaced or a modal
  // is hidden/stacked, including a fetch or worker that is still loading.
  disposeSample3dPreviews(root = null) {
    const active = this._sample3dPreview;
    if (!active || (root && !root.contains(active.container))) return;
    this._sample3dPreview = null;
    active.viewer?.dispose();
    active.container.hidden = true;
    active.button.textContent = "3D 预览";
    active.button.setAttribute("aria-expanded", "false");
  },

  async previewSample3d(button, quality = "low") {
    const container = button.closest(".sample-file-card")?.querySelector(".sample-file-model");
    if (!container) return;
    const closing = this._sample3dPreview?.container === container && !this._sample3dPreview.failed;
    this.disposeSample3dPreviews();
    if (closing) return;
    const status = container.querySelector(".sample-stl-status");
    const viewport = container.querySelector(".sample-stl-viewport");
    const reset = container.querySelector('[data-app-action="sample-file-model-reset"]');
    const pointCloud = container.dataset.modelKind === "point_cloud";
    const active = { container, button, viewer: null, pointSize: 3, quality, loading: true };
    this._sample3dPreview = active;
    container.hidden = false;
    viewport.hidden = false;
    button.textContent = "收起预览";
    button.setAttribute("aria-expanded", "true");
    reset.disabled = true;
    this.updateSample3dQualityControls(active);
    const sizeLabel = container.querySelector(".sample-point-size");
    if (sizeLabel) sizeLabel.textContent = "3 px";
    status.textContent = pointCloud ? "正在加载点云…" : "正在加载 STL 模型…";
    container.scrollIntoView?.({ block: "nearest" });
    try {
      const renderer = pointCloud ? globalThis.SamplePointCloudViewer : globalThis.SampleStlViewer;
      if (!renderer) throw new Error("3D 预览组件未加载，请刷新页面后重试。");
      active.viewer = renderer.create(viewport, {
        format: container.dataset.modelFormat,
        url: container.dataset.modelUrl,
        name: container.dataset.modelName,
        quality: active.quality,
        onStatus: message => {
          if (this._sample3dPreview === active && !active.failed && container.isConnected) status.textContent = message;
        }
      });
      await active.viewer.ready;
      if (this._sample3dPreview === active && container.isConnected) {
        active.loading = false;
        reset.disabled = false;
        this.updateSample3dQualityControls(active);
      }
    } catch (error) {
      if (this._sample3dPreview !== active) return;
      active.viewer?.dispose();
      active.viewer = null;
      active.failed = true;
      active.loading = false;
      if (!container.isConnected) return;
      this.updateSample3dQualityControls(active);
      viewport.hidden = true;
      status.textContent = `预览失败：${error.message || "无法读取三维数据"} 可重试预览或下载原文件。`;
      button.textContent = "重试预览";
    }
  },

  updateSample3dQualityControls(active) {
    active.container.querySelectorAll('[data-app-action="sample-file-model-quality"]').forEach(control => {
      control.disabled = active.loading;
      control.setAttribute("aria-pressed", String(control.dataset.quality === active.quality));
    });
  },

  async changeSample3dQuality(button) {
    const active = this._sample3dPreview;
    const quality = button.dataset.quality;
    if (!active || active.container !== button.closest(".sample-file-model") || active.loading
        || !["low", "medium", "high"].includes(quality)) return;
    if (active.failed) return this.previewSample3d(active.button, quality);
    if (quality === active.quality || !active.viewer?.setQuality) return;
    active.loading = true;
    this.updateSample3dQualityControls(active);
    try {
      await active.viewer.setQuality(quality);
      if (this._sample3dPreview === active) active.quality = quality;
    } catch (error) {
      if (this._sample3dPreview === active && active.container.isConnected) {
        active.container.querySelector(".sample-stl-status").textContent = `精细度切换失败：${error.message}。已保留原预览，可重试。`;
      }
    } finally {
      if (this._sample3dPreview === active && active.container.isConnected) {
        active.loading = false;
        this.updateSample3dQualityControls(active);
      }
    }
  },

  async mutateSampleFiles(shell, panel, category, operation) {
    if (shell.dataset.readonly === "1" || panel.dataset.busy === "1") return;
    const modalId = this._currentModalId;
    let release = null;
    panel.dataset.busy = "1";
    panel.querySelectorAll("button").forEach(button => { button.disabled = true; });
    this.setModalBusy(modalId, true);
    try {
      if (!(await this.prepareBeforeDirectMutation("样机文件操作前同步"))) throw new Error("请先完成数据同步。");
      release = await this.beginServerMutation();
      if (!release) throw new Error("其他保存操作正在进行，请稍后重试。");
      await operation();
    } catch (error) {
      Utils.toast(error.message || "文件操作失败");
    } finally {
      release?.();
      panel.dataset.busy = "0";
      this.setModalBusy(modalId, false);
      if (panel.isConnected) await this.loadSampleArchiveFiles(shell, category);
    }
  },

  // XMLHttpRequest exposes upload progress without reading the File into JS memory.
  uploadSampleArchiveFile(url, form, onProgress) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("POST", url);
      request.responseType = "json";
      request.upload.onprogress = event => {
        if (event.lengthComputable) onProgress(Math.min(100, Math.floor(event.loaded / event.total * 100)));
      };
      request.onerror = () => reject(new Error("连接中断，请重新加载文件列表确认上传结果后重试。"));
      request.onabort = () => reject(new Error("上传已取消。"));
      request.onload = () => {
        const result = request.response;
        if (request.status < 200 || request.status >= 300 || !result?.ok) {
          reject(new Error(result?.error || `文件上传失败（HTTP ${request.status}）`));
        } else resolve(result);
      };
      request.send(form);
    });
  },

  handleSampleFileAction(button, action) {
    const shell = button.closest(".sample-archive-shell");
    if (!shell) return;
    const category = button.dataset.category;
    const panel = button.closest(".sample-archive-panel");
    const sampleId = shell.dataset.sampleDetailId;
    if (action === "reload") return this.loadSampleArchiveFiles(shell, category);
    if (action === "model-preview") return this.previewSample3d(button);
    if (action === "model-quality") return this.changeSample3dQuality(button);
    if (action === "model-reset") {
      const active = this._sample3dPreview;
      if (active?.container === button.closest(".sample-file-model")) active.viewer?.reset();
      return;
    }
    if (action === "point-smaller" || action === "point-larger") {
      const active = this._sample3dPreview;
      if (active?.container !== button.closest(".sample-file-model") || active.failed) return;
      active.pointSize = Math.max(1, Math.min(8, active.pointSize + (action === "point-larger" ? 1 : -1)));
      active.viewer?.setPointSize(active.pointSize);
      const label = active.container.querySelector(".sample-point-size");
      if (label) label.textContent = `${active.pointSize} px`;
      return;
    }
    if (action === "preview") {
      const container = button.closest(".sample-file-card").querySelector(".sample-file-video");
      container.hidden = !container.hidden;
      button.textContent = container.hidden ? "播放视频" : "收起视频";
      const video = container.querySelector("video");
      if (container.hidden) video.pause(); else video.play().catch(() => {});
      return;
    }
    if (shell.dataset.readonly === "1") return;
    const apply = async (url, options) => {
      const response = await fetch(url, options);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
      this.applySamplePhotosMutationResult(sampleId, result);
    };
    const url = `/api/samples/${encodeURIComponent(sampleId)}/files`;
    if (action === "delete") {
      if (!confirm("删除这个文件？删除后无法恢复。")) return;
      return this.mutateSampleFiles(shell, panel, category, async () => {
        await apply(`${url}/${encodeURIComponent(button.dataset.fileId)}`, { method: "DELETE" });
        Utils.toast("文件已删除");
      });
    }
    if (action !== "upload") return;
    const picker = document.createElement("input");
    picker.type = "file";
    const config = this.sampleFileConfig(category);
    picker.accept = config.accept;
    picker.multiple = true;
    picker.addEventListener("change", () => {
      const files = Array.from(picker.files || []);
      if (!files.length || !panel.isConnected) return;
      const extensions = picker.accept.split(",");
      if (files.some(file => !extensions.includes("." + file.name.split(".").pop().toLowerCase()))) return Utils.toast("文件格式不支持，请按页面说明选择。");
      if (files.some(file => file.size === 0 || file.size > config.maxBytes)) return Utils.toast(`请选择非空且不超过 ${config.limitLabel} 的文件。`);
      return this.mutateSampleFiles(shell, panel, category, async () => {
        let done = 0;
        for (const file of files) {
          const status = panel.querySelector(".sample-files-status");
          const title = `正在添加 ${done + 1}/${files.length}：${file.name}`;
          status.textContent = `${title} · 0%`;
          const form = new FormData();
          form.append("category", category);
          form.append("files", file);
          try {
            const result = await this.uploadSampleArchiveFile(url, form, percent => {
              if (panel.isConnected) status.textContent = `${title} · ${percent}%${percent === 100 ? " · 正在保存…" : ""}`;
            });
            this.applySamplePhotosMutationResult(sampleId, result);
          }
          catch (error) { throw new Error(`已添加 ${done}/${files.length} 个文件；${file.name} 添加失败：${error.message}`); }
          done++;
        }
        Utils.toast(`已添加 ${done} 个文件，可继续添加。`);
      });
    }, { once: true });
    picker.click();
  },
});
