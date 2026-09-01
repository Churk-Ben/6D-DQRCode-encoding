const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const FRAME_MAGIC = Uint8Array.from([0x36, 0x44, 0x51, 0x46]); // 6DQF
const CONTAINER_MAGIC = new TextEncoder().encode("6DQRAPNG");

export const FORMAT_VERSION = 1;
export const FRAME_HEADER_BYTES = 24;
export const CONTAINER_HEADER_BYTES = 72;
export const MARKER_DARK = 128;
export const MARKER_LIGHT = 129;
export const MARKER_ACCENT = 130;
export const BACKGROUND = 131;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function concatBytes(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function bytesEqual(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function transform(bytes, stream) {
  const result = await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(result);
}

export function gzip(bytes) {
  if (!("CompressionStream" in globalThis)) throw new Error("当前浏览器不支持 CompressionStream，建议使用最新版 Chrome、Edge 或 Firefox。");
  return transform(bytes, new CompressionStream("gzip"));
}

export function gunzip(bytes) {
  if (!("DecompressionStream" in globalThis)) throw new Error("当前浏览器不支持 DecompressionStream，建议使用最新版 Chrome、Edge 或 Firefox。");
  return transform(bytes, new DecompressionStream("gzip"));
}

async function zlib(bytes, decompress = false) {
  const Stream = decompress ? DecompressionStream : CompressionStream;
  return transform(bytes, new Stream("deflate"));
}

function hslToRgb(h, s, l) {
  const saturation = s / 100;
  const lightness = l / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lightness - chroma / 2;
  let values;
  if (h < 60) values = [chroma, x, 0];
  else if (h < 120) values = [x, chroma, 0];
  else if (h < 180) values = [0, chroma, x];
  else if (h < 240) values = [0, x, chroma];
  else if (h < 300) values = [x, 0, chroma];
  else values = [chroma, 0, x];
  return values.map((value) => Math.round((value + m) * 255));
}

export function buildPalette(options = {}) {
  const settings = {
    hueOffset: Number(options.hueOffset ?? 198),
    saturation: Number(options.saturation ?? 82),
    minLightness: Number(options.minLightness ?? 17),
    lightnessSpan: Number(options.lightnessSpan ?? 58),
    shapeContrast: Number(options.shapeContrast ?? 10),
  };
  const palette = new Uint8Array(132 * 3);
  for (let state = 0; state < 64; state += 1) {
    const color = state & 7;
    const brightness = state >>> 3;
    const hue = (settings.hueOffset + color * 45) % 360;
    const base = settings.minLightness + (brightness / 7) * settings.lightnessSpan;
    for (let shape = 0; shape < 2; shape += 1) {
      const lightness = Math.max(4, Math.min(96, base + (shape ? 0.5 : -0.5) * settings.shapeContrast));
      palette.set(hslToRgb(hue, settings.saturation, lightness), (state * 2 + shape) * 3);
    }
  }
  palette.set([4, 10, 18], MARKER_DARK * 3);
  palette.set([241, 247, 250], MARKER_LIGHT * 3);
  palette.set([33, 221, 181], MARKER_ACCENT * 3);
  palette.set([8, 17, 26], BACKGROUND * 3);
  return { palette, settings };
}

function markerAt(cellX, cellY, grid) {
  const anchors = [[0, 0], [grid - 7, 0], [0, grid - 7]];
  for (let marker = 0; marker < anchors.length; marker += 1) {
    const [left, top] = anchors[marker];
    const x = cellX - left;
    const y = cellY - top;
    if (x >= 0 && x < 7 && y >= 0 && y < 7) return { x, y, marker };
  }
  return null;
}

export function isReservedCell(cellX, cellY, grid) {
  return markerAt(cellX, cellY, grid) !== null;
}

export function calculateCapacity(config) {
  const resolution = Math.floor(Number(config.resolution));
  const cellSize = Math.floor(Number(config.cellSize));
  if (!Number.isInteger(resolution) || resolution < 128 || resolution > 2048) throw new Error("分辨率必须为 128–2048 的整数。");
  if (!Number.isInteger(cellSize) || cellSize < 1 || cellSize > 32) throw new Error("码元边长必须为 1–32 的整数。");
  const grid = Math.floor(resolution / cellSize);
  if (grid < 14) throw new Error("当前参数下码元网格过小，无法放置三个定位点。");
  let reservedCells = 0;
  for (let y = 0; y < grid; y += 1) {
    for (let x = 0; x < grid; x += 1) if (isReservedCell(x, y, grid)) reservedCells += 1;
  }
  const dataCells = grid * grid - reservedCells;
  const bitsPerCell = cellSize * cellSize + 6;
  const frameBits = dataCells * bitsPerCell;
  const frameBytes = Math.floor(frameBits / 8);
  const payloadBytes = frameBytes - FRAME_HEADER_BYTES;
  if (payloadBytes < 1) throw new Error("当前参数无法容纳帧头，请提高分辨率或减小码元。");
  return { resolution, cellSize, grid, reservedCells, dataCells, bitsPerCell, frameBits, frameBytes, payloadBytes };
}

function setUint64(view, offset, value) {
  view.setBigUint64(offset, BigInt(value), false);
}

function getSafeNumber64(view, offset) {
  const value = view.getBigUint64(offset, false);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("文件尺寸超出浏览器可安全处理的范围。");
  return Number(value);
}

export async function createContainerFromBytes({ bytes, name = "decoded.bin", type = "application/octet-stream", lastModified = Date.now() }, onProgress = () => {}) {
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  onProgress({ phase: "compress", progress: 0.02, message: "正在使用 GZIP 压缩原始文件…" });
  const compressed = await gzip(raw);
  onProgress({ phase: "hash", progress: 0.08, message: "正在计算 SHA-256 完整性校验…" });
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  const nameBytes = textEncoder.encode(name);
  const typeBytes = textEncoder.encode(type || "application/octet-stream");
  if (nameBytes.length > 65535 || typeBytes.length > 65535) throw new Error("文件名或 MIME 类型过长。");
  const header = new Uint8Array(CONTAINER_HEADER_BYTES);
  header.set(CONTAINER_MAGIC, 0);
  const view = new DataView(header.buffer);
  view.setUint8(8, FORMAT_VERSION);
  view.setUint8(9, 1); // gzip
  view.setUint16(10, nameBytes.length, false);
  view.setUint16(12, typeBytes.length, false);
  view.setUint16(14, 0, false);
  setUint64(view, 16, raw.length);
  setUint64(view, 24, compressed.length);
  setUint64(view, 32, lastModified || 0);
  header.set(hash, 40);
  return {
    bytes: concatBytes([header, nameBytes, typeBytes, compressed]),
    originalSize: raw.length,
    compressedSize: compressed.length,
    hash,
  };
}

export async function createContainer(file, onProgress) {
  return createContainerFromBytes({
    bytes: new Uint8Array(await file.arrayBuffer()),
    name: file.name,
    type: file.type,
    lastModified: file.lastModified,
  }, onProgress);
}

export async function parseContainer(bytes) {
  if (bytes.length < CONTAINER_HEADER_BYTES || !bytesEqual(bytes.subarray(0, 8), CONTAINER_MAGIC)) throw new Error("数据容器标识无效。");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(8) !== FORMAT_VERSION) throw new Error(`暂不支持容器版本 ${view.getUint8(8)}。`);
  if (view.getUint8(9) !== 1) throw new Error("暂不支持该压缩算法。");
  const nameLength = view.getUint16(10, false);
  const typeLength = view.getUint16(12, false);
  const originalSize = getSafeNumber64(view, 16);
  const compressedSize = getSafeNumber64(view, 24);
  const lastModified = getSafeNumber64(view, 32);
  const hash = bytes.slice(40, 72);
  const payloadOffset = CONTAINER_HEADER_BYTES + nameLength + typeLength;
  if (payloadOffset + compressedSize > bytes.length) throw new Error("容器数据不完整。");
  const name = textDecoder.decode(bytes.subarray(CONTAINER_HEADER_BYTES, CONTAINER_HEADER_BYTES + nameLength));
  const type = textDecoder.decode(bytes.subarray(CONTAINER_HEADER_BYTES + nameLength, payloadOffset));
  const raw = await gunzip(bytes.subarray(payloadOffset, payloadOffset + compressedSize));
  if (raw.length !== originalSize) throw new Error("解压后文件尺寸不匹配。");
  const actualHash = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  if (!bytesEqual(hash, actualHash)) throw new Error("SHA-256 校验失败，APNG 数据可能已损坏。");
  return { bytes: raw, name, type, lastModified, originalSize, compressedSize, hash };
}

function framePacket(chunk, index, total) {
  const packet = new Uint8Array(FRAME_HEADER_BYTES + chunk.length);
  packet.set(FRAME_MAGIC, 0);
  const view = new DataView(packet.buffer);
  view.setUint8(4, FORMAT_VERSION);
  view.setUint8(5, 0);
  view.setUint16(6, FRAME_HEADER_BYTES, false);
  view.setUint32(8, index, false);
  view.setUint32(12, total, false);
  view.setUint32(16, chunk.length, false);
  view.setUint32(20, crc32(chunk), false);
  packet.set(chunk, FRAME_HEADER_BYTES);
  return packet;
}

function bitAt(bytes, bitOffset) {
  const byte = bytes[bitOffset >>> 3] ?? 0;
  return (byte >>> (7 - (bitOffset & 7))) & 1;
}

function markerPaletteIndex(marker) {
  const outer = marker.x === 0 || marker.x === 6 || marker.y === 0 || marker.y === 6;
  const inner = marker.x >= 2 && marker.x <= 4 && marker.y >= 2 && marker.y <= 4;
  if (inner && marker.marker === 0 && marker.x === 3 && marker.y === 3) return MARKER_ACCENT;
  return outer || inner ? MARKER_DARK : MARKER_LIGHT;
}

export function renderFrame(packet, config) {
  const details = calculateCapacity(config);
  const { resolution, cellSize, grid } = details;
  const indices = new Uint8Array(resolution * resolution);
  indices.fill(BACKGROUND);
  let bitOffset = 0;
  for (let cellY = 0; cellY < grid; cellY += 1) {
    for (let cellX = 0; cellX < grid; cellX += 1) {
      const marker = markerAt(cellX, cellY, grid);
      if (marker) {
        const value = markerPaletteIndex(marker);
        for (let py = 0; py < cellSize; py += 1) {
          const row = (cellY * cellSize + py) * resolution + cellX * cellSize;
          indices.fill(value, row, row + cellSize);
        }
        continue;
      }
      let state = 0;
      for (let bit = 0; bit < 6; bit += 1) state = (state << 1) | bitAt(packet, bitOffset++);
      for (let py = 0; py < cellSize; py += 1) {
        const row = (cellY * cellSize + py) * resolution + cellX * cellSize;
        for (let px = 0; px < cellSize; px += 1) indices[row + px] = state * 2 + bitAt(packet, bitOffset++);
      }
    }
  }
  return indices;
}

function indicesToScanlines(indices, width, height) {
  const scanlines = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y += 1) scanlines.set(indices.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  return scanlines;
}

function pngChunk(type, data) {
  const typeBytes = textEncoder.encode(type);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length, false);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(concatBytes([typeBytes, data])), false);
  return chunk;
}

function makeIHDR(width, height) {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width, false);
  view.setUint32(4, height, false);
  view.setUint8(8, 8); // indexed, 8 bits
  view.setUint8(9, 3);
  return data;
}

function makeFCTL(sequence, width, height, fps) {
  const data = new Uint8Array(26);
  const view = new DataView(data.buffer);
  view.setUint32(0, sequence, false);
  view.setUint32(4, width, false);
  view.setUint32(8, height, false);
  view.setUint32(12, 0, false);
  view.setUint32(16, 0, false);
  view.setUint16(20, 1, false);
  view.setUint16(22, Math.max(1, Math.min(65535, fps)), false);
  view.setUint8(24, 0);
  view.setUint8(25, 0);
  return data;
}

export async function encodeFileToApng(file, config, paletteOptions, onProgress = () => {}) {
  const capacity = calculateCapacity(config);
  const container = await createContainer(file, onProgress);
  const frameCount = Math.max(1, Math.ceil(container.bytes.length / capacity.payloadBytes));
  if (frameCount > 10000) throw new Error("所需帧数超过 10,000，请提高分辨率、减小码元或选择更小的文件。");
  const { palette, settings } = buildPalette(paletteOptions);
  const metadata = textEncoder.encode(JSON.stringify({
    signature: "6D-DQRCODE",
    version: FORMAT_VERSION,
    resolution: capacity.resolution,
    cellSize: capacity.cellSize,
    grid: capacity.grid,
    fps: Number(config.fps),
    bitsPerCell: capacity.bitsPerCell,
    compression: "gzip",
    palette: settings,
  }));
  const chunks = [PNG_SIGNATURE, pngChunk("IHDR", makeIHDR(capacity.resolution, capacity.resolution)), pngChunk("PLTE", palette), pngChunk("dqRC", metadata)];
  const animation = new Uint8Array(8);
  const animationView = new DataView(animation.buffer);
  animationView.setUint32(0, frameCount, false);
  animationView.setUint32(4, 0, false);
  chunks.push(pngChunk("acTL", animation));
  let sequence = 0;
  let firstFrameIndices;
  for (let index = 0; index < frameCount; index += 1) {
    const start = index * capacity.payloadBytes;
    const payload = container.bytes.subarray(start, Math.min(container.bytes.length, start + capacity.payloadBytes));
    const packet = framePacket(payload, index, frameCount);
    const indices = renderFrame(packet, capacity);
    if (index === 0) firstFrameIndices = indices.slice();
    const compressedFrame = await zlib(indicesToScanlines(indices, capacity.resolution, capacity.resolution));
    chunks.push(pngChunk("fcTL", makeFCTL(sequence++, capacity.resolution, capacity.resolution, Number(config.fps))));
    if (index === 0) {
      chunks.push(pngChunk("IDAT", compressedFrame));
    } else {
      const frameData = new Uint8Array(4 + compressedFrame.length);
      new DataView(frameData.buffer).setUint32(0, sequence++, false);
      frameData.set(compressedFrame, 4);
      chunks.push(pngChunk("fdAT", frameData));
    }
    onProgress({ phase: "encode", progress: 0.1 + 0.88 * ((index + 1) / frameCount), message: `正在生成 APNG：${index + 1} / ${frameCount} 帧` });
    if (index % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  chunks.push(pngChunk("IEND", new Uint8Array()));
  const bytes = concatBytes(chunks);
  onProgress({ phase: "done", progress: 1, message: "编码完成，文件已通过 SHA-256 校验封装。" });
  return { ...container, bytes, blob: new Blob([bytes], { type: "image/apng" }), frameCount, capacity, firstFrameIndices, palette };
}

function parseChunks(bytes) {
  if (bytes.length < 8 || !bytesEqual(bytes.subarray(0, 8), PNG_SIGNATURE)) throw new Error("不是有效的 PNG/APNG 文件。");
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
    const length = view.getUint32(0, false);
    if (offset + 12 + length > bytes.length) throw new Error("PNG 数据块不完整。");
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = textDecoder.decode(typeBytes);
    const data = bytes.slice(offset + 8, offset + 8 + length);
    const expected = view.getUint32(8 + length, false);
    if (crc32(concatBytes([typeBytes, data])) !== expected) throw new Error(`PNG 数据块 ${type} 的 CRC 校验失败。`);
    chunks.push({ type, data });
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return chunks;
}

function scanlinesToIndices(raw, width, height) {
  if (raw.length !== (width + 1) * height) throw new Error("帧像素长度与编码参数不匹配。");
  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    if (raw[y * (width + 1)] !== 0) throw new Error("暂不支持该 PNG 滤波方式；请使用本站生成的 APNG。");
    indices.set(raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width);
  }
  return indices;
}

export function decodeFrame(indices, config) {
  const capacity = calculateCapacity(config);
  const output = new Uint8Array(capacity.frameBytes);
  let bitOffset = 0;
  const writeBit = (value) => {
    if (bitOffset < output.length * 8 && value) output[bitOffset >>> 3] |= 1 << (7 - (bitOffset & 7));
    bitOffset += 1;
  };
  for (let cellY = 0; cellY < capacity.grid; cellY += 1) {
    for (let cellX = 0; cellX < capacity.grid; cellX += 1) {
      if (isReservedCell(cellX, cellY, capacity.grid)) continue;
      const firstIndex = indices[(cellY * capacity.cellSize) * capacity.resolution + cellX * capacity.cellSize];
      if (firstIndex > 127) throw new Error("数据区包含无效调色板索引。");
      const state = firstIndex >>> 1;
      for (let bit = 5; bit >= 0; bit -= 1) writeBit((state >>> bit) & 1);
      for (let py = 0; py < capacity.cellSize; py += 1) {
        const row = (cellY * capacity.cellSize + py) * capacity.resolution + cellX * capacity.cellSize;
        for (let px = 0; px < capacity.cellSize; px += 1) {
          const paletteIndex = indices[row + px];
          if (paletteIndex > 127 || (paletteIndex >>> 1) !== state) throw new Error("码元颜色状态不一致，APNG 可能被有损转码。");
          writeBit(paletteIndex & 1);
        }
      }
    }
  }
  return output;
}

function parseFramePacket(packet) {
  if (packet.length < FRAME_HEADER_BYTES || !bytesEqual(packet.subarray(0, 4), FRAME_MAGIC)) throw new Error("帧头标识无效。");
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  if (view.getUint8(4) !== FORMAT_VERSION || view.getUint16(6, false) !== FRAME_HEADER_BYTES) throw new Error("帧版本或帧头长度不受支持。");
  const index = view.getUint32(8, false);
  const total = view.getUint32(12, false);
  const length = view.getUint32(16, false);
  if (FRAME_HEADER_BYTES + length > packet.length) throw new Error(`第 ${index + 1} 帧负载不完整。`);
  const payload = packet.slice(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length);
  if (crc32(payload) !== view.getUint32(20, false)) throw new Error(`第 ${index + 1} 帧 CRC 校验失败。`);
  return { index, total, payload };
}

export async function decodeApng(input, onProgress = () => {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const chunks = parseChunks(bytes);
  const ihdr = chunks.find((chunk) => chunk.type === "IHDR");
  const metadataChunk = chunks.find((chunk) => chunk.type === "dqRC");
  const actl = chunks.find((chunk) => chunk.type === "acTL");
  if (!ihdr || !metadataChunk || !actl) throw new Error("缺少 6D-DQRCode APNG 元数据或动画控制块。");
  const ihdrView = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
  const width = ihdrView.getUint32(0, false);
  const height = ihdrView.getUint32(4, false);
  if (width !== height || ihdrView.getUint8(8) !== 8 || ihdrView.getUint8(9) !== 3) throw new Error("仅支持本站生成的 8 位索引色方形 APNG。");
  let metadata;
  try { metadata = JSON.parse(textDecoder.decode(metadataChunk.data)); } catch { throw new Error("编码参数元数据无法解析。"); }
  if (metadata.signature !== "6D-DQRCODE" || metadata.version !== FORMAT_VERSION) throw new Error("不是受支持的 6D-DQRCode 编码文件。");
  if (metadata.resolution !== width) throw new Error("APNG 尺寸与编码元数据不一致。");
  const expectedFrames = new DataView(actl.data.buffer, actl.data.byteOffset, actl.data.byteLength).getUint32(0, false);
  const compressedFrames = [];
  let current = [];
  for (const chunk of chunks) {
    if (chunk.type === "fcTL") {
      if (current.length) compressedFrames.push(concatBytes(current));
      current = [];
    } else if (chunk.type === "IDAT") current.push(chunk.data);
    else if (chunk.type === "fdAT") current.push(chunk.data.subarray(4));
  }
  if (current.length) compressedFrames.push(concatBytes(current));
  if (compressedFrames.length !== expectedFrames) throw new Error(`动画帧数不匹配：预期 ${expectedFrames}，实际 ${compressedFrames.length}。`);
  const packets = new Array(expectedFrames);
  for (let index = 0; index < compressedFrames.length; index += 1) {
    const raw = await zlib(compressedFrames[index], true);
    const indices = scanlinesToIndices(raw, width, height);
    const frame = parseFramePacket(decodeFrame(indices, metadata));
    if (frame.total !== expectedFrames || frame.index >= expectedFrames || packets[frame.index]) throw new Error("帧编号重复或超出范围。");
    packets[frame.index] = frame.payload;
    onProgress({ phase: "decode", progress: 0.05 + 0.82 * ((index + 1) / expectedFrames), message: `正在解析 APNG：${index + 1} / ${expectedFrames} 帧` });
    if (index % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (packets.some((packet) => !packet)) throw new Error("APNG 缺少部分数据帧。");
  onProgress({ phase: "verify", progress: 0.9, message: "正在解压并核对 SHA-256…" });
  const result = await parseContainer(concatBytes(packets));
  onProgress({ phase: "done", progress: 1, message: "解码成功，原始文件完整性校验通过。" });
  return { ...result, frameCount: expectedFrames, metadata };
}

export function paletteToRgba(palette, indices) {
  const rgba = new Uint8ClampedArray(indices.length * 4);
  for (let i = 0; i < indices.length; i += 1) {
    const paletteOffset = indices[i] * 3;
    const outputOffset = i * 4;
    rgba[outputOffset] = palette[paletteOffset];
    rgba[outputOffset + 1] = palette[paletteOffset + 1];
    rgba[outputOffset + 2] = palette[paletteOffset + 2];
    rgba[outputOffset + 3] = 255;
  }
  return rgba;
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
