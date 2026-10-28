/* Local STL / point-cloud inspection: no external service or runtime library.
 * Keep parseStlBlob self-contained: its source also runs in the parsing worker. */
(() => {
  "use strict";

  function parseStl(buffer) {
    const limit = 1024 * 1024 * 1024;
    if (!buffer || !Number.isFinite(buffer.byteLength) || !buffer.byteLength) throw new Error("STL 文件为空。");
    if (buffer.byteLength > limit) throw new Error("STL 文件不能超过 1 GB。");
    // The synchronous helper is only for small in-memory callers. All browser
    // previews use parseStlBlob, including small models and worker fallbacks.
    if (buffer.byteLength > 8 * 1024 * 1024) throw new Error("大 STL 文件请使用分块预览。");
    const view = new DataView(buffer);
    const declared = buffer.byteLength >= 84 ? view.getUint32(80, true) : 0;
    const binary = buffer.byteLength >= 84 && 84 + declared * 50 === buffer.byteLength;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let count = 0;
    const measure = (x, y, z) => {
      const values = [x, y, z];
      for (let axis = 0; axis < 3; axis++) {
        const value = values[axis];
        if (!Number.isFinite(value) || Math.abs(value) > 3.4028234663852886e38) throw new Error("STL 包含无效的顶点坐标。");
        min[axis] = Math.min(min[axis], value);
        max[axis] = Math.max(max[axis], value);
      }
    };
    let walk;
    if (binary) {
      walk = visit => {
        for (let face = 0; face < declared; face++) {
          const offset = 84 + face * 50 + 12;
          for (let vertex = 0; vertex < 3; vertex++) {
            const start = offset + vertex * 12;
            visit(view.getFloat32(start, true), view.getFloat32(start + 4, true), view.getFloat32(start + 8, true));
          }
        }
        return declared;
      };
    } else {
      // A binary header may begin with "solid"; exact byte-count detection above
      // takes priority. Strict ASCII grammar then catches truncated binary data.
      const text = new TextDecoder().decode(buffer).replace(/^\uFEFF/, "");
      if (!/^\s*solid(?:\s|$)/i.test(text)) throw new Error("STL 格式不正确，或二进制文件不完整。");
      walk = visit => {
        const token = /\S+/g;
        let faces = 0, solids = 0, open = false;
        const next = () => token.exec(text)?.[0] || "";
        const expect = word => {
          if (next().toLowerCase() !== word) throw new Error("STL 格式不完整：缺少 " + word + "。");
        };
        const number = () => {
          const raw = next();
          if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) throw new Error("STL 包含无效的数值。");
          const value = Number(raw);
          if (!Number.isFinite(value)) throw new Error("STL 包含无效的数值。");
          return value;
        };
        const skipName = () => {
          const end = /[\r\n]/g;
          end.lastIndex = token.lastIndex;
          token.lastIndex = end.exec(text) ? end.lastIndex : text.length;
        };
        for (let word = next(); word; word = next()) {
          switch (word.toLowerCase()) {
            case "solid":
              if (open) throw new Error("STL solid 结构不完整。");
              open = true; solids++; skipName(); break;
            case "endsolid":
              if (!open) throw new Error("STL solid 结构不正确。");
              open = false; skipName(); break;
            case "facet":
              if (!open) throw new Error("STL 三角面不在 solid 内。");
              expect("normal"); number(); number(); number();
              expect("outer"); expect("loop");
              for (let vertex = 0; vertex < 3; vertex++) {
                expect("vertex"); visit(number(), number(), number());
              }
              expect("endloop"); expect("endfacet"); faces++; break;
            default: throw new Error("无法识别的 STL 内容。");
          }
        }
        if (open || !solids) throw new Error("STL solid 结构不完整。");
        return faces;
      };
    }
    count = walk(measure);
    if (!count) throw new Error("STL 中没有可显示的三角面。");
    const size = max.map((value, axis) => value - min[axis]);
    const span = Math.max(...size);
    if (!(span > 0)) throw new Error("STL 中没有有效的三维几何数据。");
    const center = min.map((value, axis) => value + size[axis] / 2);
    // Interleaved position/normal data keeps GPU setup simple and avoids indices
    // or WebGL extensions for meshes with more than 65,535 vertices.
    const vertices = new Float32Array(count * 18);
    let cursor = 0;
    walk((x, y, z) => {
      vertices[cursor] = (x - center[0]) / span;
      vertices[cursor + 1] = (y - center[1]) / span;
      vertices[cursor + 2] = (z - center[2]) / span;
      cursor += 6;
    });
    let usefulFaces = 0;
    for (let i = 0; i < vertices.length; i += 18) {
      const ax = vertices[i + 6] - vertices[i], ay = vertices[i + 7] - vertices[i + 1], az = vertices[i + 8] - vertices[i + 2];
      const bx = vertices[i + 12] - vertices[i], by = vertices[i + 13] - vertices[i + 1], bz = vertices[i + 14] - vertices[i + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const length = Math.hypot(nx, ny, nz);
      if (length > 0) { nx /= length; ny /= length; nz /= length; usefulFaces++; }
      for (let vertex = 0; vertex < 3; vertex++) {
        vertices[i + vertex * 6 + 3] = nx;
        vertices[i + vertex * 6 + 4] = ny;
        vertices[i + vertex * 6 + 5] = nz;
      }
    }
    if (!usefulFaces) throw new Error("STL 中的三角面均已退化，无法预览。");
    return { vertices, triangleCount: count, bounds: { min, max, size }, radius: Math.hypot(...size) / span / 2 };
  }

  async function parseStlBlob(blob, options = {}, onProgress = () => {}, cancelled = () => false) {
    const MAX_FILE = 1024 * 1024 * 1024;
    const presets = { low: [100000, "流畅"], medium: [300000, "均衡"], high: [1000000, "精细"] };
    const quality = Object.hasOwn(presets, options.quality) ? options.quality : "low";
    const [budget, qualityName] = presets[quality];
    if (!blob || !Number.isFinite(blob.size) || blob.size <= 0) throw new Error("STL 文件为空。");
    if (blob.size > MAX_FILE) throw new Error("STL 文件不能超过 1 GB。");
    const check = () => { if (cancelled()) throw new DOMException("预览已取消", "AbortError"); };
    const read = async (start, end) => { check(); const value = await blob.slice(start, end).arrayBuffer(); check(); return value; };
    const header = await read(0, Math.min(84, blob.size));
    const declared = header.byteLength >= 84 ? new DataView(header).getUint32(80, true) : 0;
    const binary = header.byteLength >= 84 && declared * 50 + 84 === blob.size;
    const face = new Float64Array(9);
    // No complete ArrayBuffer, decoded string, or array of source faces is kept.
    // Each scan holds at most a 1.6 MiB binary block or a 1 MiB text block.
    const walk = async (visit, phase) => {
      let faces = 0, lastProgress = -1;
      const progress = offset => {
        const value = Math.min(100, Math.floor(offset / blob.size * 100));
        if (value >= lastProgress + 5 || (value === 100 && lastProgress !== 100)) { lastProgress = value; onProgress(phase + " " + value + "%"); }
      };
      if (binary) {
        const chunkFaces = 32768;
        for (let first = 0; first < declared; first += chunkFaces) {
          const count = Math.min(chunkFaces, declared - first);
          const data = new DataView(await read(84 + first * 50, 84 + (first + count) * 50));
          if (data.byteLength !== count * 50) throw new Error("STL 三角面数据不完整。");
          for (let index = 0; index < count; index++) {
            const offset = index * 50 + 12;
            for (let coordinate = 0; coordinate < 9; coordinate++) face[coordinate] = data.getFloat32(offset + coordinate * 4, true);
            visit(face); faces++;
          }
          progress(84 + (first + count) * 50);
        }
      } else {
        const decoder = new TextDecoder();
        const grammar = ["normal", null, null, null, "outer", "loop", "vertex", null, null, null,
          "vertex", null, null, null, "vertex", null, null, null, "endloop", "endfacet"];
        let carry = "", open = false, solids = 0, skipName = false, step = -1, coordinate = 0;
        const consume = text => {
          const tokens = /\r\n|[\r\n]|\S+/g;
          for (let match = tokens.exec(text); match; match = tokens.exec(text)) {
            const raw = match[0];
            if (raw === "\r" || raw === "\n" || raw === "\r\n") { skipName = false; continue; }
            if (skipName) continue;
            const word = raw.toLowerCase();
            if (step >= 0) {
              const expected = grammar[step];
              if (expected === null) {
                if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) throw new Error("STL 包含无效的数值。");
                const number = Number(raw);
                if (!Number.isFinite(number)) throw new Error("STL 包含无效的数值。");
                if (step >= 7) face[coordinate++] = number;
              } else if (word !== expected) throw new Error("STL 格式不完整：缺少 " + expected + "。");
              step++;
              if (step === grammar.length) { visit(face); faces++; step = -1; }
            } else if (word === "solid") {
              if (open) throw new Error("STL solid 结构不完整。");
              open = true; solids++; skipName = true;
            } else if (word === "endsolid") {
              if (!open) throw new Error("STL solid 结构不正确。");
              open = false; skipName = true;
            } else if (word === "facet" && open) {
              step = 0; coordinate = 0;
            } else throw new Error("STL 格式不正确，或二进制文件不完整。");
          }
        };
        const blockSize = 1024 * 1024;
        for (let offset = 0; offset < blob.size; offset += blockSize) {
          const end = Math.min(blob.size, offset + blockSize);
          let text = carry + decoder.decode(await read(offset, end), { stream: end < blob.size });
          let cut = text.length;
          if (end < blob.size) while (cut > 0 && !/\s/.test(text[cut - 1])) cut--;
          carry = text.slice(cut); text = text.slice(0, cut);
          if (carry.length > 65536) throw new Error("STL 文本字段过长，无法解析。");
          consume(text); progress(end);
        }
        if (carry) consume(carry);
        if (step >= 0 || open || !solids) throw new Error("STL solid 或三角面结构不完整。");
      }
      return faces;
    };
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const sourceTriangleCount = await walk(values => {
      for (let index = 0; index < 9; index++) {
        const value = values[index], axis = index % 3;
        if (!Number.isFinite(value) || Math.abs(value) > 3.4028234663852886e38) throw new Error("STL 包含无效的顶点坐标。");
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
    }, "正在读取模型范围");
    if (!sourceTriangleCount) throw new Error("STL 中没有可显示的三角面。");
    const size = max.map((value, axis) => value - min[axis]), span = Math.max(...size);
    if (!(span > 0)) throw new Error("STL 中没有有效的三维几何数据。");
    const center = min.map((value, axis) => value + size[axis] / 2);
    const simplified = sourceTriangleCount > budget;
    let divisions = simplified ? Math.max(2, Math.floor(Math.sqrt(budget / 12))) : 0;
    const overflow = {};
    for (;;) {
      check();
      const vertices = new Float32Array(Math.min(budget, sourceTriangleCount) * 18);
      const unique = simplified ? new Set() : null;
      const positions = new Float64Array(9), keys = new Float64Array(3);
      let triangleCount = 0;
      try {
        await walk(values => {
          for (let vertex = 0; vertex < 3; vertex++) {
            let key = 0;
            for (let axis = 0; axis < 3; axis++) {
              const index = vertex * 3 + axis;
              if (simplified) {
                const cell = Math.round((values[index] - min[axis]) / span * divisions);
                key = key * (divisions + 1) + cell;
                positions[index] = cell / divisions + (min[axis] - center[axis]) / span;
              } else positions[index] = (values[index] - center[axis]) / span;
            }
            keys[vertex] = key;
          }
          if (simplified && (keys[0] === keys[1] || keys[1] === keys[2] || keys[0] === keys[2])) return;
          const ax = positions[3] - positions[0], ay = positions[4] - positions[1], az = positions[5] - positions[2];
          const bx = positions[6] - positions[0], by = positions[7] - positions[1], bz = positions[8] - positions[2];
          let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
          const length = Math.hypot(nx, ny, nz);
          if (!(length > 0)) return;
          if (simplified) {
            const low = Math.min(...keys), high = Math.max(...keys), middle = keys[0] + keys[1] + keys[2] - low - high;
            const key = low + "," + middle + "," + high;
            if (unique.has(key)) return;
            if (triangleCount >= budget) throw overflow;
            unique.add(key);
          }
          nx /= length; ny /= length; nz /= length;
          const start = triangleCount++ * 18;
          for (let vertex = 0; vertex < 3; vertex++) {
            const offset = start + vertex * 6;
            vertices[offset] = positions[vertex * 3]; vertices[offset + 1] = positions[vertex * 3 + 1]; vertices[offset + 2] = positions[vertex * 3 + 2];
            vertices[offset + 3] = nx; vertices[offset + 4] = ny; vertices[offset + 5] = nz;
          }
        }, "正在生成" + qualityName + "预览" + (simplified ? "（网格 " + divisions + "）" : ""));
      } catch (error) {
        if (error !== overflow) throw error;
        // Merge vertices into coarser cells and rebuild the complete surface;
        // never select every Nth face, which would leave artificial holes.
        divisions = Math.max(1, Math.floor(divisions * .65));
        continue;
      }
      if (!triangleCount) throw new Error(simplified ? "当前精细度下模型细节过小，请选择更高精细度。" : "STL 中的三角面均已退化，无法预览。");
      return { vertices: vertices.subarray(0, triangleCount * 18), triangleCount, sourceTriangleCount,
        quality, triangleBudget: budget, simplified, bounds: { min, max, size }, radius: Math.hypot(...size) / span / 2 };
    }
  }

  function create(container, { url, name, format = "", quality = "low", onStatus = () => {} }, points = false) {
    const label = points ? "点云" : "STL 模型";
    name = name || label;
    const parser = points ? globalThis.SamplePointCloudParser?.parse : parseStlBlob;
    const canvas = document.createElement("canvas");
    canvas.className = "sample-stl-canvas" + (points ? " sample-pointcloud-canvas" : "");
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", name + " 3D 预览。方向键旋转，Shift 加方向键平移，加减键缩放，Home 复位。");
    canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none;";
    container.appendChild(canvas);
    const abort = new AbortController();
    let disposed = false, frame = 0, worker = null, workerUrl = null, rejectParse = null;
    let sourceBlob = null, sourcePromise = null, parseVersion = 0, currentSummary = null;
    let gl = null, program = null, buffer = null, resizeObserver = null, vertexCount = 0;
    let yaw = .65, pitch = -.4, zoom = 1, radius = .8, panX = 0, panY = 0, lastFit = 0, pointSize = 3;
    let draw = () => {}, contextLost = false;
    const listeners = [], pointers = new Map();
    const status = message => { if (!disposed) onStatus(message); };
    const listen = (target, event, callback, options) => {
      target.addEventListener(event, callback, options);
      listeners.push(() => target.removeEventListener(event, callback, options));
    };
    const invalidate = () => {
      if (!disposed && !contextLost && !frame) frame = requestAnimationFrame(() => { frame = 0; if (!disposed) draw(); });
    };
    const aspect = () => Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight);
    const fitZoom = () => radius * 1.3 / Math.min(1, aspect());
    const reset = () => { yaw = .65; pitch = -.4; panX = panY = 0; zoom = lastFit = fitZoom(); invalidate(); };
    const resize = () => {
      if (disposed) return;
      const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(container.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(container.clientHeight * dpr));
      const nextFit = fitZoom();
      if (lastFit) zoom *= nextFit / lastFit;
      lastFit = nextFit;
      invalidate();
    };
    const stopWorker = () => {
      worker?.terminate(); worker = null;
      if (workerUrl) URL.revokeObjectURL(workerUrl);
      workerUrl = null;
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      parseVersion++;
      abort.abort();
      sourceBlob = sourcePromise = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      rejectParse?.(new DOMException("预览已关闭", "AbortError")); rejectParse = null;
      stopWorker(); resizeObserver?.disconnect();
      listeners.splice(0).forEach(remove => remove()); pointers.clear();
      if (gl) {
        if (buffer) gl.deleteBuffer(buffer);
        if (program) gl.deleteProgram(program);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
      buffer = program = gl = null;
      draw = () => {};
      canvas.remove();
    };
    const cancelParse = () => {
      rejectParse?.(new DOMException("预览已取消", "AbortError")); rejectParse = null; stopWorker();
    };
    const parseAsync = (data, selectedQuality, token) => {
      return new Promise((resolve, reject) => {
        rejectParse = reject;
        const finish = (error, mesh) => {
          if (disposed || token !== parseVersion) return;
          stopWorker(); rejectParse = null;
          if (error) reject(error); else resolve(mesh);
        };
        const fallback = () => {
          // Blob slicing yields between blocks even where blob Workers are
          // disabled. Never decode a large STL synchronously on the UI thread.
          Promise.resolve().then(() => points ? parser(data, format) : parser(data, { quality: selectedQuality },
            message => { if (token === parseVersion) status(message); }, () => disposed || token !== parseVersion))
            .then(mesh => finish(null, mesh), error => finish(error));
        };
        if (typeof Worker === "undefined") { fallback(); return; }
        try {
          const source = points
            ? `const parseModel = ${parser.toString()}; onmessage = event => { try { const mesh = parseModel(event.data.buffer, event.data.format); postMessage({mesh}, [mesh.vertices.buffer]); } catch(error) { postMessage({error: error.message}); } };`
            : `const parseModel = ${parser.toString()}; onmessage = async event => { try { const mesh = await parseModel(event.data.blob, {quality:event.data.quality}, progress => postMessage({progress})); postMessage({mesh}, [mesh.vertices.buffer]); } catch(error) { postMessage({error: error.message}); } };`;
          workerUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
          worker = new Worker(workerUrl);
          worker.onmessage = event => {
            if (disposed || token !== parseVersion) return;
            if (event.data.progress) { status(event.data.progress); return; }
            finish(event.data.error ? new Error(event.data.error) : null, event.data.mesh);
          };
          worker.onerror = () => finish(new Error(label + "解析失败，请重试。"));
          if (points) worker.postMessage({ buffer: data, format }, [data]);
          else worker.postMessage({ blob: data, quality: selectedQuality });
        } catch (error) {
          stopWorker(); fallback();
        }
      });
    };
    const initGl = mesh => {
      if (gl && program && buffer) {
        // Upload to a fresh GPU buffer first so a failed quality change leaves
        // the last successful model and its camera available to the user.
        const previous = buffer, replacement = gl.createBuffer();
        try {
          gl.bindBuffer(gl.ARRAY_BUFFER, replacement); gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
          if (gl.getError() !== gl.NO_ERROR) throw new Error("当前设备显存不足，请选择较低精细度。");
          for (const [attribute, offset] of [["aPosition", 0], ["aNormal", 12]]) {
            const location = gl.getAttribLocation(program, attribute);
            gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 24, offset);
          }
        } catch (error) { gl.deleteBuffer(replacement); gl.bindBuffer(gl.ARRAY_BUFFER, previous); throw error; }
        buffer = replacement; gl.deleteBuffer(previous);
        vertexCount = mesh.triangleCount * 3; radius = mesh.radius; invalidate(); return;
      }
      gl = canvas.getContext("webgl", { antialias: true, alpha: false });
      if (!gl) throw new Error("当前浏览器无法使用 WebGL，暂不能预览。请启用硬件加速或下载文件查看。");
      const shader = (type, source) => {
        const item = gl.createShader(type);
        gl.shaderSource(item, source); gl.compileShader(item);
        if (!gl.getShaderParameter(item, gl.COMPILE_STATUS)) { gl.deleteShader(item); throw new Error("3D 渲染初始化失败。"); }
        return item;
      };
      const vertex = shader(gl.VERTEX_SHADER, points ? `
        attribute vec3 aPosition; attribute vec3 aColor;
        uniform mat3 uRotation; uniform vec2 uScale; uniform vec2 uPan; uniform float uPointSize;
        varying vec3 vColor;
        void main() { vec3 p = uRotation * aPosition;
          vColor = aColor; gl_PointSize = uPointSize;
          gl_Position = vec4((p.xy + uPan) * uScale, -p.z / 4.0, 1.0); }
      ` : `
        attribute vec3 aPosition; attribute vec3 aNormal;
        uniform mat3 uRotation; uniform vec2 uScale; uniform vec2 uPan;
        varying vec3 vNormal;
        void main() { vec3 p = uRotation * aPosition;
          vNormal = uRotation * aNormal; gl_Position = vec4((p.xy + uPan) * uScale, -p.z / 4.0, 1.0); }
      `);
      let fragment;
      try {
        fragment = shader(gl.FRAGMENT_SHADER, points ? `
          precision mediump float; varying vec3 vColor;
          void main() { vec2 offset = gl_PointCoord - vec2(0.5);
            if (dot(offset, offset) > 0.25) discard;
            gl_FragColor = vec4(vColor, 1.0); }
        ` : `
          precision mediump float; varying vec3 vNormal;
          void main() { vec3 n = normalize(vNormal); if (!gl_FrontFacing) n = -n;
            float key = max(0.0, dot(n, normalize(vec3(-0.5, 0.8, 1.0))));
            float fill = max(0.0, dot(n, normalize(vec3(0.8, -0.3, 0.4))));
            float rim = pow(1.0 - abs(n.z), 3.0);
            vec3 color = vec3(0.54, 0.74, 0.85) * (0.35 + key * 0.56 + fill * 0.22) + rim * 0.05;
            gl_FragColor = vec4(color, 1.0); }
        `);
        program = gl.createProgram(); gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
      } finally { gl.deleteShader(vertex); if (fragment) gl.deleteShader(fragment); }
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("3D 渲染初始化失败。");
      gl.useProgram(program);
      buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
      if (gl.getError() !== gl.NO_ERROR) throw new Error(label + "过大，当前设备显存不足。可下载后查看或上传简化后的文件。");
      for (const [attribute, offset] of [["aPosition", 0], [points ? "aColor" : "aNormal", 12]]) {
        const location = gl.getAttribLocation(program, attribute);
        gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 24, offset);
      }
      const rotation = gl.getUniformLocation(program, "uRotation"), scale = gl.getUniformLocation(program, "uScale"), pan = gl.getUniformLocation(program, "uPan");
      const pointSizeUniform = points ? gl.getUniformLocation(program, "uPointSize") : null;
      const pointRange = points ? gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) : null;
      const maxPointSize = Number(pointRange?.[1]) || 64;
      vertexCount = points ? mesh.pointCount : mesh.triangleCount * 3; radius = mesh.radius;
      gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.clearColor(.055, .082, .12, 1);
      draw = () => {
        if (!gl || contextLost) return;
        const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.uniformMatrix3fv(rotation, false, [cy, sp * sy, -cp * sy, 0, cp, sp, sy, -sp * cy, cp * cy]);
        gl.uniform2f(scale, 1 / (zoom * canvas.width / canvas.height), 1 / zoom);
        gl.uniform2f(pan, panX, panY);
        if (points) gl.uniform1f(pointSizeUniform, Math.min(maxPointSize, pointSize * Math.min(globalThis.devicePixelRatio || 1, 2)));
        gl.drawArrays(points ? gl.POINTS : gl.TRIANGLES, 0, vertexCount);
      };
      reset(); resize();
    };
    const changeZoom = factor => { zoom = Math.max(radius * .02, Math.min(radius * 100, zoom * factor)); invalidate(); };
    const setPointSize = value => {
      const next = Number(value);
      if (!Number.isFinite(next)) return;
      pointSize = Math.max(1, Math.min(8, next)); invalidate();
    };
    const movePan = (dx, dy) => { const unit = 2 * zoom / Math.max(container.clientHeight, 1); panX += dx * unit; panY -= dy * unit; invalidate(); };
    listen(canvas, "contextmenu", event => event.preventDefault());
    listen(canvas, "pointerdown", event => {
      if (![0, 1, 2].includes(event.button)) return;
      canvas.focus({ preventScroll: true }); canvas.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); event.preventDefault();
    });
    listen(canvas, "pointermove", event => {
      const previous = pointers.get(event.pointerId);
      if (!previous) return;
      const next = { x: event.clientX, y: event.clientY };
      if (pointers.size === 2) {
        const other = [...pointers].find(([id]) => id !== event.pointerId)[1];
        const oldDistance = Math.hypot(previous.x - other.x, previous.y - other.y);
        const newDistance = Math.hypot(next.x - other.x, next.y - other.y);
        if (oldDistance > 1 && newDistance > 1) changeZoom(oldDistance / newDistance);
        movePan((next.x - previous.x) / 2, (next.y - previous.y) / 2);
      } else if (event.buttons === 2 || event.buttons === 4 || event.shiftKey) {
        movePan(next.x - previous.x, next.y - previous.y);
      } else {
        yaw += (next.x - previous.x) * .008; pitch += (next.y - previous.y) * .008; invalidate();
      }
      pointers.set(event.pointerId, next);
    });
    for (const eventName of ["pointerup", "pointercancel", "lostpointercapture"]) listen(canvas, eventName, event => pointers.delete(event.pointerId));
    listen(canvas, "wheel", event => { event.preventDefault(); changeZoom(Math.exp(Math.max(-1, Math.min(1, event.deltaY * .001)))); }, { passive: false });
    listen(canvas, "keydown", event => {
      const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (arrows[event.key]) {
        const [dx, dy] = arrows[event.key];
        if (event.shiftKey) movePan(dx * 20, dy * 20); else { yaw += dx * .12; pitch += dy * .12; invalidate(); }
      } else if (event.key === "+" || event.key === "=") changeZoom(.85);
      else if (event.key === "-" || event.key === "_") changeZoom(1 / .85);
      else if (event.key === "Home" || event.key === "0") reset();
      else return;
      event.preventDefault(); event.stopPropagation();
    });
    listen(canvas, "webglcontextlost", event => {
      event.preventDefault(); contextLost = true;
      status("3D 渲染已中断，请收起预览后重新打开。");
    });
    if (typeof ResizeObserver !== "undefined") { resizeObserver = new ResizeObserver(resize); resizeObserver.observe(container); }
    else listen(globalThis, "resize", resize);
    const loadSource = () => {
      if (sourceBlob) return Promise.resolve(sourceBlob);
      if (!sourcePromise) sourcePromise = (async () => {
        if (typeof parser !== "function") throw new Error("点云解析组件未加载，请刷新页面后重试。");
        status("正在加载" + label + "…");
        const response = await fetch(url, { signal: abort.signal, cache: "no-store" });
        if (!response.ok) throw new Error(label + "文件读取失败（HTTP " + response.status + "）。");
        const limit = points ? 75 * 1024 * 1024 : 1024 * 1024 * 1024;
        const length = Number(response.headers.get("Content-Length") || 0);
        if (length > limit) throw new Error(label + "文件不能超过 " + (points ? "75 MB。" : "1 GB。"));
        const data = points ? await response.arrayBuffer() : await response.blob();
        if (disposed) throw new DOMException("预览已关闭", "AbortError");
        if ((points ? data.byteLength : data.size) > limit) throw new Error(label + "文件不能超过 " + (points ? "75 MB。" : "1 GB。"));
        if (!points) sourceBlob = data;
        return data;
      })().finally(() => { sourcePromise = null; });
      return sourcePromise;
    };
    const renderQuality = async selectedQuality => {
      if (disposed) throw new DOMException("预览已关闭", "AbortError");
      if (!["low", "medium", "high"].includes(selectedQuality)) selectedQuality = "low";
      const token = ++parseVersion;
      cancelParse();
      try {
        const data = await loadSource();
        if (disposed || token !== parseVersion) throw new DOMException("预览已取消", "AbortError");
        status(points ? "正在解析点云…" : "正在解析三维网格…");
        const mesh = await parseAsync(data, selectedQuality, token);
        if (disposed || token !== parseVersion) throw new DOMException("预览已取消", "AbortError");
        initGl(mesh);
        const summary = points ? {
          pointCount: mesh.pointCount, sourcePointCount: mesh.sourcePointCount,
          skippedPointCount: mesh.skippedPointCount, bounds: mesh.bounds
        } : { triangleCount: mesh.triangleCount, sourceTriangleCount: mesh.sourceTriangleCount,
          quality: mesh.quality, triangleBudget: mesh.triangleBudget, simplified: mesh.simplified, bounds: mesh.bounds };
        let detail = points ? mesh.pointCount.toLocaleString() + " 个点" : mesh.triangleCount.toLocaleString() + " 个三角面";
        if (points && mesh.sourcePointCount > mesh.pointCount) detail = "预览 " + detail + " / 原始 " + mesh.sourcePointCount.toLocaleString() + " 个点";
        if (points && mesh.skippedPointCount) detail += "（已跳过 " + mesh.skippedPointCount.toLocaleString() + " 个无效点）";
        if (!points) detail = ({ low: "流畅", medium: "均衡", high: "精细" }[mesh.quality]) + " · 显示 " + detail + " / 原始 " + mesh.sourceTriangleCount.toLocaleString() + " 个三角面" + (mesh.simplified ? "（简化预览，原文件不变）" : "");
        status(detail + " · 拖动旋转，滚轮缩放，右键拖动平移");
        currentSummary = summary;
        return summary;
      } catch (error) {
        if (!currentSummary && token === parseVersion && error.name !== "AbortError") dispose();
        throw error;
      }
    };
    const ready = renderQuality(quality);
    return { ready, dispose, reset, resize, ...(points ? { setPointSize } : { setQuality: renderQuality }) };
  }

  globalThis.SampleStlViewer = { create, parse: parseStl, parseBlob: parseStlBlob };
  globalThis.SamplePointCloudViewer = { create: (container, options) => create(container, options, true) };
})();
