import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPalette,
  calculateCapacity,
  createContainerFromBytes,
  decodeApng,
  decodeAvi,
  decodeMov,
  decodeFrame,
  encodeFileToApng,
  encodeFileToAvi,
  encodeFileToMov,
  parseContainer,
  renderFrame,
} from "../site/codec.js";

if (!globalThis.crypto) globalThis.crypto = (await import("node:crypto")).webcrypto;

test("码元帧映射可逐位往返", () => {
  const config = { resolution: 128, cellSize: 4, fps: 30 };
  const capacity = calculateCapacity(config);
  const packet = new Uint8Array(capacity.frameBytes);
  for (let index = 0; index < packet.length; index += 1) packet[index] = (index * 73 + 19) & 0xff;
  const pixels = renderFrame(packet, config);
  assert.deepEqual(decodeFrame(pixels, config), packet);
});

test("1px 码元可承载 1 个形状位和 6 个颜色亮度位", () => {
  const config = { resolution: 128, cellSize: 1, fps: 60 };
  const capacity = calculateCapacity(config);
  assert.equal(capacity.bitsPerCell, 7);
  const packet = new Uint8Array(capacity.frameBytes);
  for (let index = 0; index < packet.length; index += 1) packet[index] = (index * 149 + 37) & 0xff;
  assert.deepEqual(decodeFrame(renderFrame(packet, config), config), packet);
});

test("文件容器经 GZIP 和 SHA-256 校验后可还原", async () => {
  const source = new TextEncoder().encode("6D-DQRCode 无损容器测试\n".repeat(200));
  const container = await createContainerFromBytes({ bytes: source, name: "论证.txt", type: "text/plain", lastModified: 123456789 });
  assert.ok(container.compressedSize < container.originalSize);
  const restored = await parseContainer(container.bytes);
  assert.equal(restored.name, "论证.txt");
  assert.equal(restored.type, "text/plain");
  assert.equal(restored.lastModified, 123456789);
  assert.deepEqual(restored.bytes, source);
});

test("完整 APNG 编码和解码可跨多帧往返", async () => {
  const source = new Uint8Array(20000);
  let state = 0x6d3a2f19;
  for (let index = 0; index < source.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    source[index] = state & 0xff;
  }
  const fileLike = {
    name: "sample.bin",
    type: "application/octet-stream",
    lastModified: 987654321,
    arrayBuffer: async () => source.buffer.slice(0),
  };
  const encoded = await encodeFileToApng(fileLike, { resolution: 128, cellSize: 4, fps: 24 }, buildPalette().settings);
  assert.ok(encoded.frameCount > 1);
  assert.equal(encoded.bytes[1], 80);
  const decoded = await decodeApng(encoded.bytes);
  assert.equal(decoded.name, fileLike.name);
  assert.equal(decoded.frameCount, encoded.frameCount);
  assert.deepEqual(decoded.bytes, source);
});

test("PNG 无损视频轨道可封装为 MOV 并还原", async () => {
  const source = new Uint8Array(9000);
  let state = 0x51f2a9c3;
  for (let index = 0; index < source.length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    source[index] = state >>> 24;
  }
  const fileLike = {
    name: "lossless.dat",
    type: "application/octet-stream",
    lastModified: 246813579,
    arrayBuffer: async () => source.buffer.slice(0),
  };
  const encoded = await encodeFileToMov(fileLike, { resolution: 128, cellSize: 4, fps: 25 }, buildPalette().settings);
  assert.equal(new TextDecoder().decode(encoded.bytes.subarray(4, 8)), "ftyp");
  assert.equal(new TextDecoder().decode(encoded.bytes.subarray(8, 12)), "qt  ");
  assert.ok(encoded.frameCount > 1);
  const decoded = await decodeMov(encoded.bytes);
  assert.equal(decoded.name, fileLike.name);
  assert.equal(decoded.frameCount, encoded.frameCount);
  assert.deepEqual(decoded.bytes, source);
});

test("8 位调色板 AVI 可直接封装并无损还原", async () => {
  const source = new Uint8Array(5000);
  let state = 0x13a7c9e1;
  for (let index = 0; index < source.length; index += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    source[index] = state >>> 24;
  }
  const fileLike = {
    name: "windows-playback.bin",
    type: "application/octet-stream",
    lastModified: 135792468,
    arrayBuffer: async () => source.buffer.slice(0),
  };
  const encoded = await encodeFileToAvi(fileLike, { resolution: 128, cellSize: 4, fps: 30 }, buildPalette().settings);
  assert.equal(new TextDecoder().decode(encoded.bytes.subarray(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(encoded.bytes.subarray(8, 12)), "AVI ");
  assert.ok(encoded.bytes.length < encoded.frameCount * 128 * 128 * 2, "AVI 应接近每像素 1 字节，而不是 RGB24 的 3 字节");
  const decoded = await decodeAvi(encoded.bytes);
  assert.equal(decoded.name, fileLike.name);
  assert.equal(decoded.frameCount, encoded.frameCount);
  assert.deepEqual(decoded.bytes, source);
});
