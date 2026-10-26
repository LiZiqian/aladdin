/* Local point-cloud readers. Keep parse self-contained so the viewer can run
 * the same parser in a worker. Original files are never rewritten or sampled. */
(() => {
  "use strict";

  function parse(buffer, format) {
    const MAX_FILE = 75 * 1024 * 1024, MAX_EXPANDED = 256 * 1024 * 1024;
    const MAX_SOURCE = 10000000, MAX_PREVIEW = 1000000, MAX_HEADER = 1024 * 1024;
    if (!buffer || !Number.isFinite(buffer.byteLength) || !buffer.byteLength) throw new Error("点云文件为空。");
    if (buffer.byteLength > MAX_FILE) throw new Error("点云文件不能超过 75 MB。");
    const bytes = new Uint8Array(buffer), decoder = new TextDecoder("utf-8", { fatal: true });
    format = String(format || "").toLowerCase().replace(/^\./, "");
    let walk, sourcePointCount;
    const fail = message => { throw new Error(message); };
    const unsigned = (raw, label, max = MAX_SOURCE) => {
      if (!/^\d+$/.test(String(raw))) fail(label + "必须是非负整数。");
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value > max) fail(label + "超出预览范围。");
      return value;
    };
    const numeric = (raw, allowSpecial = true) => {
      if (allowSpecial && /^[+-]?(?:nan|inf(?:inity)?)$/i.test(raw)) {
        return /nan/i.test(raw) ? NaN : raw[0] === "-" ? -Infinity : Infinity;
      }
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) fail("点云包含无法识别的数值。");
      return Number(raw);
    };
    const types = {
      char: { size: 1, method: "getInt8", min: -128, max: 127 },
      uchar: { size: 1, method: "getUint8", min: 0, max: 255 },
      short: { size: 2, method: "getInt16", min: -32768, max: 32767 },
      ushort: { size: 2, method: "getUint16", min: 0, max: 65535 },
      int: { size: 4, method: "getInt32", min: -2147483648, max: 2147483647 },
      uint: { size: 4, method: "getUint32", min: 0, max: 4294967295 },
      float: { size: 4, method: "getFloat32", float: true },
      double: { size: 8, method: "getFloat64", float: true },
    };
    for (const [alias, name] of Object.entries({ int8: "char", uint8: "uchar", int16: "short", uint16: "ushort", int32: "int", uint32: "uint", float32: "float", float64: "double" })) types[alias] = types[name];
    const typeFor = name => Object.prototype.hasOwnProperty.call(types, name) ? types[name] : fail("不支持的点云字段类型：" + name);
    const typedNumber = (raw, type) => {
      if (type.float) return numeric(raw);
      if (!/^[+-]?\d+$/.test(raw)) fail("整数字段包含无效数值。");
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < type.min || value > type.max) fail("整数字段超出声明范围。");
      return value;
    };
    const colorChannel = (value, scale) => {
      if (!Number.isFinite(value) || value < 0 || value > scale) fail("点云 RGB 颜色超出声明范围。");
      return value / scale;
    };
    const colorScale = type => type.float ? 1 : type.max;
    function* lines(text) {
      for (const match of text.matchAll(/[^\r\n]+/g)) {
        const line = match[0].trim();
        if (line) yield line;
      }
    }
    // Read only the header. Decoding the entire binary body as text corrupts
    // offsets and can allocate a much larger string for large scans.
    const header = terminator => {
      let offset = 0;
      const result = [];
      while (offset < bytes.length && offset < MAX_HEADER) {
        const start = offset;
        while (offset < bytes.length && bytes[offset] !== 10 && bytes[offset] !== 13 && offset < MAX_HEADER) offset++;
        if (offset >= MAX_HEADER) fail("点云文件头过大或不完整。");
        const line = decoder.decode(bytes.subarray(start, offset)).replace(/^\uFEFF/, "").trim();
        if (bytes[offset] === 13) offset++;
        if (bytes[offset] === 10) offset++;
        result.push(line);
        if (terminator(line)) return { lines: result, offset };
      }
      fail("点云文件头不完整。");
    };
    const validTail = (data, offset) => {
      for (let i = offset; i < data.length; i++) if (![9, 10, 13, 32].includes(data[i])) fail("点云数据长度与文件头不一致。");
    };
    const colorsFromNames = properties => {
      const names = properties.map(p => p.name);
      const keys = ["red", "green", "blue"].every(name => names.includes(name)) ? ["red", "green", "blue"]
        : ["r", "g", "b"].every(name => names.includes(name)) ? ["r", "g", "b"] : null;
      if (!keys && names.some(name => ["red", "green", "blue", "r", "g", "b"].includes(name))) fail("RGB 颜色字段必须同时包含三个通道。");
      return keys && keys.map(name => properties.findIndex(p => p.name === name));
    };

    if (format === "ply") {
      const info = header(line => line === "end_header");
      if (info.lines[0] !== "ply") fail("PLY 文件头必须以 ply 开始。");
      const elements = [];
      let mode = "", current = null;
      for (const line of info.lines.slice(1)) {
        const parts = line.split(/\s+/), key = parts[0];
        if (!line || key === "comment" || key === "obj_info" || key === "end_header") continue;
        if (key === "format") {
          if (mode || parts.length !== 3 || parts[2] !== "1.0" || !["ascii", "binary_little_endian", "binary_big_endian"].includes(parts[1])) fail("不支持或重复的 PLY format 声明。");
          mode = parts[1];
        } else if (key === "element") {
          if (parts.length !== 3 || elements.some(el => el.name === parts[1]) || elements.length >= 256) fail("PLY element 声明不正确。");
          current = { name: parts[1], count: unsigned(parts[2], "PLY 记录数"), properties: [] };
          elements.push(current);
        } else if (key === "property") {
          if (!current || current.properties.length >= 256) fail("PLY property 声明不正确。");
          let property;
          if (parts[1] === "list") {
            if (parts.length !== 5) fail("PLY 列表属性不完整。");
            const countType = typeFor(parts[2]);
            if (countType.float) fail("PLY 列表长度必须使用整数类型。");
            property = { name: parts[4], type: typeFor(parts[3]), countType };
          } else {
            if (parts.length !== 3) fail("PLY 标量属性不完整。");
            property = { name: parts[2], type: typeFor(parts[1]) };
          }
          if (current.properties.some(p => p.name === property.name)) fail("PLY 属性名重复。");
          current.properties.push(property);
        } else fail("无法识别的 PLY 文件头声明：" + key);
      }
      const vertex = elements.find(el => el.name === "vertex");
      if (!mode || !vertex || !vertex.count || elements.some(el => el.count && !el.properties.length)) fail("PLY 缺少有效的顶点数据。");
      if (elements.reduce((sum, el) => sum + el.count, 0) > MAX_SOURCE * 2) fail("PLY 记录数超出预览范围。");
      const xyz = ["x", "y", "z"].map(name => vertex.properties.findIndex(p => p.name === name && !p.countType));
      if (xyz.includes(-1)) fail("PLY 顶点必须包含 x、y、z 标量。");
      const rgb = colorsFromNames(vertex.properties);
      if (rgb?.some(index => vertex.properties[index].countType)) fail("PLY 颜色必须为标量。");
      sourcePointCount = vertex.count;
      const text = mode === "ascii" ? decoder.decode(bytes.subarray(info.offset)) : null;
      const view = new DataView(buffer), little = mode !== "binary_big_endian";
      walk = visit => {
        let offset = info.offset;
        const records = text === null ? null : lines(text);
        let tokens = null, rowText = "";
        const read = type => {
          if (tokens) {
            const token = tokens.exec(rowText)?.[0];
            if (token === undefined) fail("PLY 数据不完整。");
            return typedNumber(token, type);
          }
          if (offset + type.size > bytes.length) fail("PLY 二进制数据不完整。");
          const value = view[type.method](offset, little); offset += type.size; return value;
        };
        for (const element of elements) {
          for (let row = 0; row < element.count; row++) {
            if (records) {
              const record = records.next();
              if (record.done) fail("PLY 数据少于声明的记录数。");
              rowText = record.value; tokens = /\S+/g;
            }
            const values = element === vertex ? [] : null;
            for (let p = 0; p < element.properties.length; p++) {
              const property = element.properties[p];
              if (property.countType) {
                const count = read(property.countType);
                if (count < 0 || count > MAX_SOURCE) fail("PLY 列表长度无效。");
                if (!tokens) {
                  if (offset + count * property.type.size > bytes.length) fail("PLY 列表数据不完整。");
                  offset += count * property.type.size;
                } else for (let i = 0; i < count; i++) read(property.type);
              } else {
                const value = read(property.type);
                if (values) values[p] = value;
              }
            }
            if (tokens?.exec(rowText)) fail("PLY 行列数量与文件头不一致。");
            if (values) {
              const color = xyz.every(index => Number.isFinite(values[index])) ? rgb?.map(index => colorChannel(values[index], colorScale(vertex.properties[index].type))) : null;
              visit(values[xyz[0]], values[xyz[1]], values[xyz[2]], ...(color || []));
            }
          }
        }
        if (records && !records.next().done) fail("PLY 数据多于声明的记录数。");
        if (!records) validTail(bytes, offset);
      };
    } else if (format === "pcd") {
      const info = header(line => /^DATA\s/i.test(line));
      const entries = Object.create(null);
      for (const raw of info.lines) {
        const line = raw.replace(/#.*/, "").trim();
        if (!line) continue;
        const [keyRaw, ...values] = line.split(/\s+/), key = keyRaw.toUpperCase();
        if (entries[key] || !["VERSION", "FIELDS", "SIZE", "TYPE", "COUNT", "WIDTH", "HEIGHT", "VIEWPOINT", "POINTS", "DATA"].includes(key)) fail("PCD 文件头重复或包含未知声明。");
        entries[key] = values;
      }
      if (!["FIELDS", "SIZE", "TYPE", "WIDTH", "HEIGHT", "DATA"].every(key => entries[key]?.length)) fail("PCD 文件头缺少必要字段。");
      const names = entries.FIELDS, fieldCount = names.length;
      if (fieldCount > 1024 || entries.SIZE.length !== fieldCount || entries.TYPE.length !== fieldCount || (entries.COUNT && entries.COUNT.length !== fieldCount)) fail("PCD 字段声明数量不一致。");
      if (new Set(names.filter(name => name !== "_")).size !== names.filter(name => name !== "_").length) fail("PCD 字段名重复。");
      const width = entries.WIDTH.length === 1 && unsigned(entries.WIDTH[0], "PCD WIDTH");
      const height = entries.HEIGHT.length === 1 && unsigned(entries.HEIGHT[0], "PCD HEIGHT");
      sourcePointCount = entries.POINTS ? entries.POINTS.length === 1 && unsigned(entries.POINTS[0], "PCD POINTS") : width * height;
      if (!sourcePointCount || !width || !height || sourcePointCount !== width * height || sourcePointCount > MAX_SOURCE) fail("PCD POINTS 与 WIDTH × HEIGHT 不一致或超出范围。");
      let stride = 0, scalarCount = 0;
      const fields = names.map((name, index) => {
        const size = unsigned(entries.SIZE[index], "PCD 字段大小", 8), kind = entries.TYPE[index].toUpperCase();
        const type = ({ I: { 1: types.char, 2: types.short, 4: types.int }, U: { 1: types.uchar, 2: types.ushort, 4: types.uint }, F: { 4: types.float, 8: types.double } })[kind]?.[size];
        if (!type) fail("不支持的 PCD TYPE / SIZE 组合。");
        const count = entries.COUNT ? unsigned(entries.COUNT[index], "PCD COUNT", 65536) : 1;
        if (!count) fail("PCD COUNT 必须大于零。");
        const field = { name, type, count, size, kind, offset: stride, scalar: scalarCount, block: stride * sourcePointCount };
        stride += size * count; scalarCount += count;
        return field;
      });
      const expanded = stride * sourcePointCount;
      if (!Number.isSafeInteger(expanded) || expanded > MAX_EXPANDED) fail("PCD 解压数据超过 256 MB 预览上限。");
      const xyz = ["x", "y", "z"].map(name => fields.find(field => field.name === name && field.count === 1));
      if (xyz.some(field => !field)) fail("PCD 必须包含 x、y、z 标量字段。");
      const colorFields = colorsFromNames(fields)?.map(index => fields[index]);
      if (colorFields?.some(field => field.count !== 1)) fail("PCD 颜色必须为标量。");
      const packed = fields.find(field => field.name === "rgb") || fields.find(field => field.name === "rgba");
      if (packed && (packed.count !== 1 || packed.size !== 4)) fail("PCD rgb / rgba 必须为 32 位标量。");
      const mode = entries.DATA.length === 1 && entries.DATA[0].toLowerCase();
      if (!["ascii", "binary", "binary_compressed"].includes(mode)) fail("不支持的 PCD DATA 格式。");
      let payload = bytes.subarray(info.offset);
      if (mode === "binary_compressed") {
        if (payload.length < 8) fail("PCD 压缩数据不完整。");
        const lengths = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const compressed = lengths.getUint32(0, true), uncompressed = lengths.getUint32(4, true);
        if (uncompressed !== expanded || compressed !== payload.length - 8) fail("PCD 压缩长度与文件头不一致。");
        const input = payload.subarray(8), output = new Uint8Array(expanded);
        let inputAt = 0, outputAt = 0;
        while (inputAt < input.length) {
          const control = input[inputAt++];
          if (control < 32) {
            const length = control + 1;
            if (inputAt + length > input.length || outputAt + length > output.length) fail("PCD LZF 字面数据损坏。");
            output.set(input.subarray(inputAt, inputAt + length), outputAt);
            inputAt += length; outputAt += length;
          } else {
            let length = control >> 5, reference = outputAt - ((control & 31) << 8) - 1;
            if (length === 7) {
              if (inputAt >= input.length) fail("PCD LZF 长度数据损坏。");
              length += input[inputAt++];
            }
            if (inputAt >= input.length) fail("PCD LZF 引用数据损坏。");
            reference -= input[inputAt++]; length += 2;
            if (reference < 0 || outputAt + length > output.length) fail("PCD LZF 引用越界。");
            for (let i = 0; i < length; i++) output[outputAt++] = output[reference++];
          }
        }
        if (outputAt !== output.length) fail("PCD LZF 解压长度不匹配。");
        payload = output;
      } else if (mode === "binary") {
        if (payload.length < expanded) fail("PCD 二进制数据不完整。");
        validTail(payload, expanded);
      }
      const bitView = new DataView(new ArrayBuffer(4));
      const rgbValues = packedValue => [(packedValue >>> 16 & 255) / 255, (packedValue >>> 8 & 255) / 255, (packedValue & 255) / 255];
      const text = mode === "ascii" ? decoder.decode(payload) : null;
      const dataView = text === null ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength) : null;
      walk = visit => {
        if (text !== null) {
          let rows = 0;
          for (const raw of lines(text)) {
            if (raw.startsWith("#")) continue;
            const tokens = raw.split(/\s+/);
            if (tokens.length !== scalarCount || rows >= sourcePointCount) fail("PCD 行列数量与文件头不一致。");
            const values = [];
            for (const field of fields) for (let j = 0; j < field.count; j++) values[field.scalar + j] = typedNumber(tokens[field.scalar + j], field.type);
            const validCoordinates = xyz.every(field => Number.isFinite(values[field.scalar]));
            let color = validCoordinates ? colorFields?.map(field => colorChannel(values[field.scalar], colorScale(field.type))) : null;
            if (packed && validCoordinates) {
              const value = values[packed.scalar];
              if (packed.kind === "F") { bitView.setFloat32(0, value, true); color = Number.isFinite(value) ? rgbValues(bitView.getUint32(0, true)) : null; }
              else color = rgbValues(value >>> 0);
            }
            visit(...xyz.map(field => values[field.scalar]), ...(color || [])); rows++;
          }
          if (rows !== sourcePointCount) fail("PCD 点数少于文件头声明。");
        } else {
          const offsetFor = (field, row) => mode === "binary_compressed" ? field.block + row * field.size * field.count : row * stride + field.offset;
          for (let row = 0; row < sourcePointCount; row++) {
            const read = field => dataView[field.type.method](offsetFor(field, row), true);
            const coordinates = xyz.map(read), validCoordinates = coordinates.every(Number.isFinite);
            let color = validCoordinates ? colorFields?.map(field => colorChannel(read(field), colorScale(field.type))) : null;
            if (packed && validCoordinates) color = rgbValues(dataView.getUint32(offsetFor(packed, row), true));
            visit(...coordinates, ...(color || []));
          }
        }
      };
    } else if (["xyz", "txt", "pts"].includes(format)) {
      const text = decoder.decode(bytes).replace(/^\uFEFF/, "");
      let expected = null, columns = null;
      const scan = visit => {
        let count = 0, hasCount = false;
        for (const raw of lines(text)) {
          const line = raw.replace(/#.*/, "").trim();
          if (!line) continue;
          if (format === "pts" && !hasCount) {
            const declared = unsigned(line, "PTS 点数");
            if (!declared) fail("PTS 中没有点数据。");
            expected = declared; hasCount = true; continue;
          }
          if (/^\s*,|,\s*(?:,|$)/.test(line)) fail("点云文本包含空列。");
          const tokens = line.split(/[\s,]+/);
          if (![3, 4, 6, 7].includes(tokens.length) || (columns !== null && columns !== tokens.length)) fail("点云文本须使用一致的 3、4、6 或 7 列（XYZ、XYZ I、XYZ RGB、XYZ I RGB）。");
          columns = tokens.length;
          const values = tokens.map(value => numeric(value));
          const color = columns >= 6 && values.slice(0, 3).every(Number.isFinite) ? values.slice(-3).map(value => colorChannel(value, 255)) : null;
          visit(values[0], values[1], values[2], ...(color || []));
          if (++count > MAX_SOURCE || (expected !== null && count > expected)) fail("点云点数超出声明或预览范围。");
        }
        if (expected !== null && count !== expected) fail("PTS 点数与首行声明不一致。");
        if (!count) fail("点云文件中没有点数据。");
        return count;
      };
      walk = visit => { sourcePointCount = scan(visit); };
    } else fail("不支持的点云格式，请使用 PLY、PCD、XYZ、PTS 或 TXT。");

    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let valid = 0, skippedPointCount = 0;
    const finite = (x, y, z) => Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
    walk((x, y, z) => {
      if (!finite(x, y, z)) { skippedPointCount++; return; }
      const coordinates = [x, y, z];
      for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], coordinates[axis]); max[axis] = Math.max(max[axis], coordinates[axis]); }
      valid++;
    });
    if (!valid) fail("点云中没有有限的 XYZ 坐标可供预览。");
    const size = max.map((value, axis) => value - min[axis]);
    if (size.some(value => !Number.isFinite(value))) fail("点云坐标范围过大，无法安全预览。");
    const span = Math.max(...size) || 1, center = min.map((value, axis) => value + size[axis] / 2);
    const pointCount = Math.min(valid, MAX_PREVIEW), vertices = new Float32Array(pointCount * 6);
    let validIndex = 0, stored = 0;
    // Sampling uses finite-point rank, so missing PCD pixels cannot remove every
    // selected point. Bounds retain the entire valid cloud, not just the sample.
    walk((x, y, z, r, g, b) => {
      if (!finite(x, y, z)) return;
      const selected = validIndex === Math.floor(stored * valid / pointCount);
      validIndex++;
      if (!selected || stored >= pointCount) return;
      const at = stored++ * 6;
      vertices[at] = (x - center[0]) / span; vertices[at + 1] = (y - center[1]) / span; vertices[at + 2] = (z - center[2]) / span;
      if (r === undefined) {
        const height = size[2] ? (z - min[2]) / size[2] : .5;
        r = .18 + height * .65; g = .65 + Math.sin(height * Math.PI) * .22; b = .92 - height * .5;
      }
      vertices[at + 3] = r; vertices[at + 4] = g; vertices[at + 5] = b;
    });
    return { vertices, pointCount, sourcePointCount, skippedPointCount, bounds: { min, max, size }, radius: Math.hypot(...size.map(value => value / span)) / 2 || .5 };
  }

  globalThis.SamplePointCloudParser = { parse };
})();
