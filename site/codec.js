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

function makeEncodingMetadata(capacity, config, settings, mediaFormat) {
  return textEncoder.encode(JSON.stringify({
    signature: "6D-DQRCODE",
    version: FORMAT_VERSION,
    mediaFormat,
    resolution: capacity.resolution,
    cellSize: capacity.cellSize,
    grid: capacity.grid,
    fps: Number(config.fps),
    bitsPerCell: capacity.bitsPerCell,
    compression: "gzip",
    palette: settings,
  }));
}

async function makeStandalonePng(indices, palette, metadata, resolution) {
  const compressedFrame = await zlib(indicesToScanlines(indices, resolution, resolution));
  return concatBytes([
    PNG_SIGNATURE,
    pngChunk("IHDR", makeIHDR(resolution, resolution)),
    pngChunk("PLTE", palette),
    pngChunk("dqRC", metadata),
    pngChunk("IDAT", compressedFrame),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

function movAtom(type, ...parts) {
  const data = concatBytes(parts);
  if (data.length + 8 > 0xffffffff) throw new Error("MOV 数据块超过 32 位容器限制。");
  const output = new Uint8Array(data.length + 8);
  const view = new DataView(output.buffer);
  view.setUint32(0, output.length, false);
  output.set(textEncoder.encode(type), 4);
  output.set(data, 8);
  return output;
}

function movMatrix(view, offset) {
  const matrix = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
  matrix.forEach((value, index) => view.setUint32(offset + index * 4, value, false));
}

function makeMvhd(timescale, duration) {
  const data = new Uint8Array(100);
  const view = new DataView(data.buffer);
  view.setUint32(12, timescale, false);
  view.setUint32(16, duration, false);
  view.setUint32(20, 0x00010000, false);
  view.setUint16(24, 0x0100, false);
  movMatrix(view, 36);
  view.setUint32(96, 2, false);
  return movAtom("mvhd", data);
}

function makeTkhd(width, height, duration) {
  const data = new Uint8Array(84);
  const view = new DataView(data.buffer);
  view.setUint32(0, 7, false);
  view.setUint32(12, 1, false);
  view.setUint32(20, duration, false);
  movMatrix(view, 40);
  view.setUint32(76, width << 16, false);
  view.setUint32(80, height << 16, false);
  return movAtom("tkhd", data);
}

function makeMdhd(timescale, duration) {
  const data = new Uint8Array(24);
  const view = new DataView(data.buffer);
  view.setUint32(12, timescale, false);
  view.setUint32(16, duration, false);
  view.setUint16(20, 0x55c4, false); // und
  return movAtom("mdhd", data);
}

function makeHdlr() {
  const name = textEncoder.encode("VideoHandler\0");
  const data = new Uint8Array(24 + name.length);
  data.set(textEncoder.encode("vide"), 8);
  data.set(name, 24);
  return movAtom("hdlr", data);
}

function makeVisualSampleEntry(width, height) {
  const data = new Uint8Array(78);
  const view = new DataView(data.buffer);
  view.setUint16(6, 1, false);
  view.setUint16(24, width, false);
  view.setUint16(26, height, false);
  view.setUint32(28, 0x00480000, false);
  view.setUint32(32, 0x00480000, false);
  view.setUint16(40, 1, false);
  const compressor = textEncoder.encode("PNG lossless");
  data[42] = compressor.length;
  data.set(compressor, 43);
  view.setUint16(74, 24, false);
  view.setUint16(76, 0xffff, false);
  return movAtom("png ", data);
}

function makeStbl(width, height, sampleSizes, firstSampleOffset) {
  const stsdData = new Uint8Array(8);
  new DataView(stsdData.buffer).setUint32(4, 1, false);
  const stsd = movAtom("stsd", stsdData, makeVisualSampleEntry(width, height));

  const sttsData = new Uint8Array(16);
  const sttsView = new DataView(sttsData.buffer);
  sttsView.setUint32(4, 1, false);
  sttsView.setUint32(8, sampleSizes.length, false);
  sttsView.setUint32(12, 1, false);

  const stscData = new Uint8Array(20);
  const stscView = new DataView(stscData.buffer);
  stscView.setUint32(4, 1, false);
  stscView.setUint32(8, 1, false);
  stscView.setUint32(12, sampleSizes.length, false);
  stscView.setUint32(16, 1, false);

  const stszData = new Uint8Array(12 + sampleSizes.length * 4);
  const stszView = new DataView(stszData.buffer);
  stszView.setUint32(8, sampleSizes.length, false);
  sampleSizes.forEach((size, index) => stszView.setUint32(12 + index * 4, size, false));

  const stcoData = new Uint8Array(12);
  const stcoView = new DataView(stcoData.buffer);
  stcoView.setUint32(4, 1, false);
  stcoView.setUint32(8, firstSampleOffset, false);
  return movAtom("stbl", stsd, movAtom("stts", sttsData), movAtom("stsc", stscData), movAtom("stsz", stszData), movAtom("stco", stcoData));
}

function makeMov(samples, width, height, fps) {
  const ftypData = new Uint8Array(12);
  ftypData.set(textEncoder.encode("qt  "), 0);
  new DataView(ftypData.buffer).setUint32(4, 0x20050300, false);
  ftypData.set(textEncoder.encode("qt  "), 8);
  const ftyp = movAtom("ftyp", ftypData);
  const sampleData = concatBytes(samples);
  const firstSampleOffset = ftyp.length + 8;
  const mdat = movAtom("mdat", sampleData);
  const timescale = Math.max(1, Math.min(65535, Math.round(fps)));

  const vmhdData = new Uint8Array(12);
  new DataView(vmhdData.buffer).setUint32(0, 1, false);
  const urlData = new Uint8Array(4);
  new DataView(urlData.buffer).setUint32(0, 1, false);
  const drefData = new Uint8Array(8);
  new DataView(drefData.buffer).setUint32(4, 1, false);
  const dinf = movAtom("dinf", movAtom("dref", drefData, movAtom("url ", urlData)));
  const stbl = makeStbl(width, height, samples.map((sample) => sample.length), firstSampleOffset);
  const minf = movAtom("minf", movAtom("vmhd", vmhdData), dinf, stbl);
  const mdia = movAtom("mdia", makeMdhd(timescale, samples.length), makeHdlr(), minf);
  const trak = movAtom("trak", makeTkhd(width, height, samples.length), mdia);
  const moov = movAtom("moov", makeMvhd(timescale, samples.length), trak);
  return concatBytes([ftyp, mdat, moov]);
}

function riffChunk(type, data) {
  const padding = data.length & 1;
  const output = new Uint8Array(8 + data.length + padding);
  const view = new DataView(output.buffer);
  output.set(textEncoder.encode(type), 0);
  view.setUint32(4, data.length, true);
  output.set(data, 8);
  return output;
}

function riffList(type, ...children) {
  return riffChunk("LIST", concatBytes([textEncoder.encode(type), ...children]));
}

function riffFile(type, ...children) {
  const data = concatBytes([textEncoder.encode(type), ...children]);
  const padding = data.length & 1;
  const output = new Uint8Array(8 + data.length + padding);
  const view = new DataView(output.buffer);
  view.setUint32(4, data.length, true);
  output.set(textEncoder.encode("RIFF"), 0);
  output.set(data, 8);
  return output;
}

function makeAviFrame(indices, width, height) {
  const rowStride = (width + 3) & ~3;
  const output = new Uint8Array(rowStride * height);
  for (let outputY = 0; outputY < height; outputY += 1) {
    const sourceY = height - 1 - outputY;
    const sourceRow = sourceY * width;
    const targetRow = outputY * rowStride;
    output.set(indices.subarray(sourceRow, sourceRow + width), targetRow);
  }
  return output;
}

function makeAviHeader(width, height, fps, frameCount, frameSize) {
  const data = new Uint8Array(56);
  const view = new DataView(data.buffer);
  view.setUint32(0, Math.round(1_000_000 / Math.max(1, fps)), true);
  view.setUint32(4, Math.min(0xffffffff, frameSize * Math.max(1, fps)), true);
  view.setUint32(12, 0x10, true); // AVIF_HASINDEX
  view.setUint32(16, frameCount, true);
  view.setUint32(20, 0, true);
  view.setUint32(24, 1, true);
  view.setUint32(28, frameSize, true);
  view.setUint32(32, width, true);
  view.setUint32(36, height, true);
  return riffChunk("avih", data);
}

function makeAviStreamHeader(width, height, fps, frameCount, frameSize) {
  const data = new Uint8Array(56);
  const view = new DataView(data.buffer);
  data.set(textEncoder.encode("vids"), 0);
  data.set(textEncoder.encode("DIB "), 4); // BI_RGB / uncompressed DIB
  view.setUint32(20, 1, true);
  view.setUint32(24, Math.max(1, Math.round(fps)), true);
  view.setUint32(32, frameCount, true);
  view.setUint32(36, frameSize, true);
  view.setUint32(40, 0xffffffff, true);
  view.setUint32(44, 0, true);
  view.setUint16(48, 0, true);
  view.setUint16(50, 0, true);
  view.setUint16(52, width, true);
  view.setUint16(54, height, true);
  return riffChunk("strh", data);
}

function makeAviBitmapInfo(width, height, frameSize, palette) {
  const colorCount = 256;
  const data = new Uint8Array(40 + colorCount * 4);
  const view = new DataView(data.buffer);
  view.setUint32(0, 40, true);
  view.setInt32(4, width, true);
  view.setInt32(8, height, true); // bottom-up 8-bit indexed DIB
  view.setUint16(12, 1, true);
  view.setUint16(14, 8, true);
  view.setUint32(16, 0, true); // BI_RGB
  view.setUint32(20, frameSize, true);
  view.setInt32(24, 2835, true);
  view.setInt32(28, 2835, true);
  view.setUint32(32, colorCount, true);
  view.setUint32(36, colorCount, true);
  for (let index = 0; index < Math.min(colorCount, palette.length / 3); index += 1) {
    const paletteOffset = index * 3;
    const tableOffset = 40 + index * 4;
    data[tableOffset] = palette[paletteOffset + 2];
    data[tableOffset + 1] = palette[paletteOffset + 1];
    data[tableOffset + 2] = palette[paletteOffset];
  }
  return riffChunk("strf", data);
}

function makeAvi(samples, metadata, palette, width, height, fps) {
  const frameSize = samples[0]?.length ?? 0;
  const frameChunks = samples.map((sample) => riffChunk("00db", sample));
  const movi = riffList("movi", ...frameChunks);
  const indexData = new Uint8Array(frameChunks.length * 16);
  const indexView = new DataView(indexData.buffer);
  let relativeOffset = 4;
  frameChunks.forEach((chunk, index) => {
    const offset = index * 16;
    indexData.set(textEncoder.encode("00db"), offset);
    indexView.setUint32(offset + 4, 0x10, true);
    indexView.setUint32(offset + 8, relativeOffset, true);
    indexView.setUint32(offset + 12, samples[index].length, true);
    relativeOffset += chunk.length;
  });
  const dmlhData = new Uint8Array(248);
  new DataView(dmlhData.buffer).setUint32(0, samples.length, true);
  const streamHeader = makeAviStreamHeader(width, height, fps, samples.length, frameSize);
  const streamFormat = makeAviBitmapInfo(width, height, frameSize, palette);
  const strl = riffList("strl", streamHeader, streamFormat);
  const hdrl = riffList("hdrl", makeAviHeader(width, height, fps, samples.length, frameSize), strl, riffList("odml", riffChunk("dmlh", dmlhData)));
  const root = riffFile("AVI ", hdrl, movi, riffChunk("idx1", indexData), riffChunk("dqRC", metadata));
  if (root.length > 0xffffffff) throw new Error("AVI 文件超过 4 GiB，当前浏览器封装器暂不支持。");
  return root;
}

export async function encodeFileToApng(file, config, paletteOptions, onProgress = () => {}) {
  const capacity = calculateCapacity(config);
  const container = await createContainer(file, onProgress);
  const frameCount = Math.max(1, Math.ceil(container.bytes.length / capacity.payloadBytes));
  if (frameCount > 10000) throw new Error("所需帧数超过 10,000，请提高分辨率、减小码元或选择更小的文件。");
  const { palette, settings } = buildPalette(paletteOptions);
  const metadata = makeEncodingMetadata(capacity, config, settings, "apng");
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

export async function encodeFileToMov(file, config, paletteOptions, onProgress = () => {}) {
  const capacity = calculateCapacity(config);
  const container = await createContainer(file, onProgress);
  const frameCount = Math.max(1, Math.ceil(container.bytes.length / capacity.payloadBytes));
  if (frameCount > 10000) throw new Error("所需帧数超过 10,000，请提高分辨率、减小码元或选择更小的文件。");
  const { palette, settings } = buildPalette(paletteOptions);
  const metadata = makeEncodingMetadata(capacity, config, settings, "mov-png");
  const samples = [];
  let firstFrameIndices;
  for (let index = 0; index < frameCount; index += 1) {
    const start = index * capacity.payloadBytes;
    const payload = container.bytes.subarray(start, Math.min(container.bytes.length, start + capacity.payloadBytes));
    const indices = renderFrame(framePacket(payload, index, frameCount), capacity);
    if (index === 0) firstFrameIndices = indices.slice();
    samples.push(await makeStandalonePng(indices, palette, metadata, capacity.resolution));
    onProgress({ phase: "encode", progress: 0.1 + 0.86 * ((index + 1) / frameCount), message: `正在生成 MOV 无损帧：${index + 1} / ${frameCount}` });
    if (index % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const bytes = makeMov(samples, capacity.resolution, capacity.resolution, Number(config.fps));
  onProgress({ phase: "done", progress: 1, message: "MOV 编码完成，PNG 无损视频轨道已封装。" });
  return { ...container, bytes, blob: new Blob([bytes], { type: "video/quicktime" }), frameCount, capacity, firstFrameIndices, palette, format: "mov" };
}

export async function encodeFileToAvi(file, config, paletteOptions, onProgress = () => {}) {
  const capacity = calculateCapacity(config);
  const container = await createContainer(file, onProgress);
  const frameCount = Math.max(1, Math.ceil(container.bytes.length / capacity.payloadBytes));
  if (frameCount > 10000) throw new Error("所需帧数超过 10,000，请提高分辨率、减小码元或选择更小的文件。");
  const { palette, settings } = buildPalette(paletteOptions);
  const metadata = makeEncodingMetadata(capacity, config, settings, "avi-pal8");
  const samples = [];
  let firstFrameIndices;
  for (let index = 0; index < frameCount; index += 1) {
    const start = index * capacity.payloadBytes;
    const payload = container.bytes.subarray(start, Math.min(container.bytes.length, start + capacity.payloadBytes));
    const indices = renderFrame(framePacket(payload, index, frameCount), capacity);
    if (index === 0) firstFrameIndices = indices.slice();
    samples.push(makeAviFrame(indices, capacity.resolution, capacity.resolution));
    onProgress({ phase: "encode", progress: 0.1 + 0.86 * ((index + 1) / frameCount), message: `正在生成 AVI 调色板帧：${index + 1} / ${frameCount}` });
    if (index % 2 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const bytes = makeAvi(samples, metadata, palette, capacity.resolution, capacity.resolution, Number(config.fps));
  onProgress({ phase: "done", progress: 1, message: "AVI 编码完成，8 位调色板无损视频已封装。" });
  return { ...container, bytes, blob: new Blob([bytes], { type: "video/x-msvideo" }), frameCount, capacity, firstFrameIndices, palette, format: "avi" };
}

export function encodeFileToMedia(file, config, paletteOptions, format = "apng", onProgress = () => {}) {
  if (format === "mov") return encodeFileToMov(file, config, paletteOptions, onProgress);
  if (format === "avi") return encodeFileToAvi(file, config, paletteOptions, onProgress);
  return encodeFileToApng(file, config, paletteOptions, onProgress);
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

async function decodeStandalonePng(bytes) {
  const chunks = parseChunks(bytes);
  const ihdr = chunks.find((chunk) => chunk.type === "IHDR");
  const metadataChunk = chunks.find((chunk) => chunk.type === "dqRC");
  const idat = chunks.filter((chunk) => chunk.type === "IDAT");
  if (!ihdr || !metadataChunk || !idat.length) throw new Error("MOV 帧缺少 PNG 图像数据或 6D-DQRCode 元数据。");
  const view = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
  const width = view.getUint32(0, false);
  const height = view.getUint32(4, false);
  if (width !== height || view.getUint8(8) !== 8 || view.getUint8(9) !== 3) throw new Error("MOV 中包含不受支持的 PNG 帧格式。");
  let metadata;
  try { metadata = JSON.parse(textDecoder.decode(metadataChunk.data)); } catch { throw new Error("MOV 帧的编码参数元数据无法解析。"); }
  const raw = await zlib(concatBytes(idat.map((chunk) => chunk.data)), true);
  return { metadata, indices: scanlinesToIndices(raw, width, height), width, height };
}

function parseMovAtoms(bytes) {
  const atoms = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
    let size = view.getUint32(0, false);
    const type = textDecoder.decode(bytes.subarray(offset + 4, offset + 8));
    if (size === 1) throw new Error("暂不支持 64 位扩展尺寸的 MOV 数据块。");
    if (size === 0) size = bytes.length - offset;
    if (size < 8 || offset + size > bytes.length) throw new Error(`MOV 数据块 ${type} 不完整。`);
    atoms.push({ type, data: bytes.subarray(offset + 8, offset + size), offset, size });
    offset += size;
  }
  if (offset !== bytes.length) throw new Error("MOV 末尾存在无法解析的数据。");
  return atoms;
}

function movChild(atom, type) {
  const child = parseMovAtoms(atom.data).find((item) => item.type === type);
  if (!child) throw new Error(`MOV 缺少 ${type} 数据块。`);
  return child;
}

function extractMovSamples(bytes) {
  const top = parseMovAtoms(bytes);
  const ftyp = top.find((atom) => atom.type === "ftyp");
  const moov = top.find((atom) => atom.type === "moov");
  if (!ftyp || !moov || textDecoder.decode(ftyp.data.subarray(0, 4)) !== "qt  ") throw new Error("不是受支持的 QuickTime MOV 文件。");
  const trak = movChild(moov, "trak");
  const mdia = movChild(trak, "mdia");
  const minf = movChild(mdia, "minf");
  const stbl = movChild(minf, "stbl");
  const stsz = movChild(stbl, "stsz");
  const stco = movChild(stbl, "stco");
  if (stsz.data.length < 12 || stco.data.length < 12) throw new Error("MOV 样本表不完整。");
  const sizeView = new DataView(stsz.data.buffer, stsz.data.byteOffset, stsz.data.byteLength);
  const uniformSize = sizeView.getUint32(4, false);
  const count = sizeView.getUint32(8, false);
  if (!count || count > 10000) throw new Error("MOV 帧数无效或超过 10,000 帧限制。");
  const sampleSizes = [];
  if (uniformSize) {
    for (let index = 0; index < count; index += 1) sampleSizes.push(uniformSize);
  } else {
    if (stsz.data.length < 12 + count * 4) throw new Error("MOV 帧尺寸表不完整。");
    for (let index = 0; index < count; index += 1) sampleSizes.push(sizeView.getUint32(12 + index * 4, false));
  }
  const chunkView = new DataView(stco.data.buffer, stco.data.byteOffset, stco.data.byteLength);
  if (chunkView.getUint32(4, false) !== 1) throw new Error("暂不支持多区块 MOV 文件；请使用本站生成的 MOV。");
  let offset = chunkView.getUint32(8, false);
  return sampleSizes.map((size) => {
    if (!size || offset + size > bytes.length) throw new Error("MOV 帧数据超出文件范围。");
    const sample = bytes.subarray(offset, offset + size);
    offset += size;
    return sample;
  });
}

function parseRiffChildren(bytes, start, end) {
  const children = [];
  let offset = start;
  while (offset + 8 <= end) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
    const type = textDecoder.decode(bytes.subarray(offset, offset + 4));
    const size = view.getUint32(4, true);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > end || size < 0) throw new Error(`AVI 数据块 ${type} 不完整。`);
    if (type === "LIST") {
      if (size < 4) throw new Error("AVI LIST 数据块不完整。");
      const listType = textDecoder.decode(bytes.subarray(dataStart, dataStart + 4));
      children.push({ type, listType, offset, size, data: bytes.subarray(dataStart + 4, dataEnd), children: parseRiffChildren(bytes, dataStart + 4, dataEnd) });
    } else {
      children.push({ type, offset, size, data: bytes.subarray(dataStart, dataEnd) });
    }
    offset = dataEnd + (size & 1);
  }
  if (offset !== end) throw new Error("AVI 末尾存在无法解析的数据。");
  return children;
}

function extractAviSamples(bytes) {
  if (bytes.length < 12 || textDecoder.decode(bytes.subarray(0, 4)) !== "RIFF" || textDecoder.decode(bytes.subarray(8, 12)) !== "AVI ") throw new Error("不是受支持的 AVI 文件。");
  const riffSize = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, true);
  const end = Math.min(bytes.length, 8 + riffSize);
  const children = parseRiffChildren(bytes, 12, end);
  const metadataChunk = children.find((child) => child.type === "dqRC");
  const movi = children.find((child) => child.type === "LIST" && child.listType === "movi");
  if (!metadataChunk || !movi) throw new Error("AVI 缺少 6D-DQRCode 元数据或视频数据。");
  let metadata;
  try { metadata = JSON.parse(textDecoder.decode(metadataChunk.data)); } catch { throw new Error("AVI 编码参数元数据无法解析。"); }
  const frames = movi.children.filter((child) => child.type === "00db" || child.type === "00dc").map((child) => child.data);
  if (!frames.length || frames.length > 10000) throw new Error("AVI 帧数无效或超过 10,000 帧限制。");
  return { frames, metadata };
}

function decodeAviFrame(frame, metadata) {
  const width = Number(metadata.resolution);
  const height = width;
  if (metadata.mediaFormat === "avi-pal8") {
    const rowStride = (width + 3) & ~3;
    if (frame.length !== rowStride * height) throw new Error("AVI 调色板帧长度与编码参数不匹配。");
    const indices = new Uint8Array(width * height);
    for (let storedY = 0; storedY < height; storedY += 1) {
      const targetY = height - 1 - storedY;
      const sourceRow = storedY * rowStride;
      const targetRow = targetY * width;
      indices.set(frame.subarray(sourceRow, sourceRow + width), targetRow);
    }
    if (indices.some((index) => index >= 132)) throw new Error("AVI 调色板帧包含协议范围外的索引；文件可能被转码。");
    return indices;
  }
  const rowStride = (width * 3 + 3) & ~3;
  if (frame.length !== rowStride * height) throw new Error("AVI RGB 帧长度与编码参数不匹配。");
  const { palette } = buildPalette(metadata.palette || {});
  const paletteMap = new Map();
  for (let index = 0; index < 132; index += 1) {
    const offset = index * 3;
    paletteMap.set((palette[offset] << 16) | (palette[offset + 1] << 8) | palette[offset + 2], index);
  }
  const indices = new Uint8Array(width * height);
  for (let storedY = 0; storedY < height; storedY += 1) {
    const targetY = height - 1 - storedY;
    const row = storedY * rowStride;
    for (let x = 0; x < width; x += 1) {
      const source = row + x * 3;
      const key = (frame[source + 2] << 16) | (frame[source + 1] << 8) | frame[source];
      const index = paletteMap.get(key);
      if (index === undefined) throw new Error("AVI RGB 帧包含不在协议调色板内的颜色；文件可能被转码。");
      indices[targetY * width + x] = index;
    }
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
          if (paletteIndex > 127 || (paletteIndex >>> 1) !== state) throw new Error("码元颜色状态不一致，媒体文件可能被有损转码。");
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

export async function decodeMov(input, onProgress = () => {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const samples = extractMovSamples(bytes);
  const packets = new Array(samples.length);
  let metadata;
  for (let index = 0; index < samples.length; index += 1) {
    const decoded = await decodeStandalonePng(samples[index]);
    if (!metadata) metadata = decoded.metadata;
    if (metadata.signature !== "6D-DQRCODE" || metadata.version !== FORMAT_VERSION || metadata.resolution !== decoded.width) throw new Error("MOV 帧不是受支持的 6D-DQRCode 编码格式。");
    const frame = parseFramePacket(decodeFrame(decoded.indices, metadata));
    if (frame.total !== samples.length || frame.index >= samples.length || packets[frame.index]) throw new Error("MOV 帧编号重复或与视频样本数不匹配。");
    packets[frame.index] = frame.payload;
    onProgress({ phase: "decode", progress: 0.05 + 0.82 * ((index + 1) / samples.length), message: `正在解析 MOV：${index + 1} / ${samples.length} 帧` });
    if (index % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (packets.some((packet) => !packet)) throw new Error("MOV 缺少部分数据帧。");
  onProgress({ phase: "verify", progress: 0.9, message: "正在解压并核对 SHA-256…" });
  const result = await parseContainer(concatBytes(packets));
  onProgress({ phase: "done", progress: 1, message: "MOV 解码成功，原始文件完整性校验通过。" });
  return { ...result, frameCount: samples.length, metadata, mediaFormat: "mov" };
}

export async function decodeAvi(input, onProgress = () => {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const { frames, metadata } = extractAviSamples(bytes);
  const supportedFormat = metadata.mediaFormat === "avi-pal8" || metadata.mediaFormat === "avi-rgb24";
  if (metadata.signature !== "6D-DQRCODE" || metadata.version !== FORMAT_VERSION || !supportedFormat) throw new Error("不是本站生成的 AVI 无损视频。");
  const packets = new Array(frames.length);
  for (let index = 0; index < frames.length; index += 1) {
    const indices = decodeAviFrame(frames[index], metadata);
    const frame = parseFramePacket(decodeFrame(indices, metadata));
    if (frame.total !== frames.length || frame.index >= frames.length || packets[frame.index]) throw new Error("AVI 帧编号重复或与视频样本数不匹配。");
    packets[frame.index] = frame.payload;
    onProgress({ phase: "decode", progress: 0.05 + 0.82 * ((index + 1) / frames.length), message: `正在解析 AVI：${index + 1} / ${frames.length} 帧` });
    if (index % 2 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (packets.some((packet) => !packet)) throw new Error("AVI 缺少部分数据帧。");
  onProgress({ phase: "verify", progress: 0.9, message: "正在解压并核对 SHA-256…" });
  const result = await parseContainer(concatBytes(packets));
  onProgress({ phase: "done", progress: 1, message: "AVI 解码成功，原始文件完整性校验通过。" });
  return { ...result, frameCount: frames.length, metadata, mediaFormat: "avi" };
}

export function decodeMedia(input, onProgress = () => {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length >= 8 && bytesEqual(bytes.subarray(0, 8), PNG_SIGNATURE)) return decodeApng(bytes, onProgress);
  if (bytes.length >= 12 && textDecoder.decode(bytes.subarray(4, 8)) === "ftyp") return decodeMov(bytes, onProgress);
  if (bytes.length >= 12 && textDecoder.decode(bytes.subarray(0, 4)) === "RIFF" && textDecoder.decode(bytes.subarray(8, 12)) === "AVI ") return decodeAvi(bytes, onProgress);
  throw new Error("请选择本站生成的 APNG、MOV 或 AVI 文件。");
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
