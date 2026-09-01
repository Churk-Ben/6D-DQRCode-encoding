import {
  buildPalette,
  bytesToHex,
  calculateCapacity,
  decodeApng,
  encodeFileToApng,
  paletteToRgba,
} from "./codec.js";

const $ = (selector) => document.querySelector(selector);
const elements = {
  encodeFile: $("#encode-file"), encodeDropzone: $("#encode-dropzone"), encodeChip: $("#encode-file-chip"),
  decodeFile: $("#decode-file"), decodeDropzone: $("#decode-dropzone"), decodeChip: $("#decode-file-chip"),
  resolution: $("#resolution"), cellSize: $("#cell-size"), fps: $("#fps"),
  hue: $("#hue"), saturation: $("#saturation"), lightness: $("#lightness"), contrast: $("#contrast"),
  palette: $("#palette"), encodeButton: $("#encode-button"), decodeButton: $("#decode-button"),
  encodeStatus: $("#encode-status"), encodeStatusText: $("#encode-status-text"), encodePercent: $("#encode-percent"), encodeProgress: $("#encode-progress"),
  decodeStatus: $("#decode-status"), decodeStatusText: $("#decode-status-text"), decodePercent: $("#decode-percent"), decodeProgress: $("#decode-progress"),
  encodeResult: $("#encode-result"), decodeResult: $("#decode-result"), canvas: $("#frame-preview"),
  apngDownload: $("#apng-download"), fileDownload: $("#file-download"), toast: $("#toast"),
};

let sourceFile = null;
let apngFile = null;
let encodeUrl = null;
let decodeUrl = null;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(2)} ${units[unit]}`;
}

function config() {
  return { resolution: Number(elements.resolution.value), cellSize: Number(elements.cellSize.value), fps: Number(elements.fps.value) };
}

function paletteConfig() {
  return {
    hueOffset: Number(elements.hue.value), saturation: Number(elements.saturation.value),
    minLightness: 17, lightnessSpan: Number(elements.lightness.value), shapeContrast: Number(elements.contrast.value),
  };
}

function setOutput(id, value) { $(id).value = value; $(id).textContent = value; }

function updateControls() {
  const value = config();
  setOutput("#resolution-value", `${value.resolution} × ${value.resolution}`);
  setOutput("#cell-size-value", `${value.cellSize} px`);
  setOutput("#fps-value", `${value.fps} fps`);
  setOutput("#hue-value", `${elements.hue.value}°`);
  setOutput("#saturation-value", `${elements.saturation.value}%`);
  setOutput("#lightness-value", `${elements.lightness.value}%`);
  setOutput("#contrast-value", `${elements.contrast.value}%`);
  try {
    const capacity = calculateCapacity(value);
    const speed = capacity.frameBits * value.fps / 1_000_000;
    $("#metric-capacity").textContent = formatBytes(capacity.payloadBytes);
    $("#metric-speed").textContent = `${speed.toFixed(2)} Mbps`;
    $("#metric-frames").textContent = sourceFile ? `≈ ${Math.max(1, Math.ceil((sourceFile.size + 512) / capacity.payloadBytes))}` : "—";
  } catch (error) {
    $("#metric-capacity").textContent = "参数无效";
    $("#metric-speed").textContent = "—";
    $("#metric-frames").textContent = "—";
  }
  drawPalette();
}

function drawPalette() {
  const { palette } = buildPalette(paletteConfig());
  elements.palette.replaceChildren();
  for (let brightness = 0; brightness < 8; brightness += 1) {
    for (let color = 0; color < 8; color += 1) {
      const state = brightness * 8 + color;
      const offset = (state * 2 + 1) * 3;
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.title = `颜色 ${color + 1} · 亮度 ${brightness + 1}`;
      swatch.style.background = `rgb(${palette[offset]}, ${palette[offset + 1]}, ${palette[offset + 2]})`;
      elements.palette.append(swatch);
    }
  }
}

function chooseFile(file, mode) {
  if (!file) return;
  if (mode === "encode") {
    sourceFile = file;
    elements.encodeChip.textContent = `${file.name} · ${formatBytes(file.size)}`;
    elements.encodeChip.classList.add("ready");
    elements.encodeButton.disabled = false;
    elements.encodeResult.hidden = true;
    updateControls();
  } else {
    apngFile = file;
    elements.decodeChip.textContent = `${file.name} · ${formatBytes(file.size)}`;
    elements.decodeChip.classList.add("ready");
    elements.decodeButton.disabled = false;
    elements.decodeResult.hidden = true;
  }
}

function setupDropzone(zone, input, mode) {
  input.addEventListener("change", () => chooseFile(input.files[0], mode));
  for (const event of ["dragenter", "dragover"]) zone.addEventListener(event, (e) => { e.preventDefault(); zone.classList.add("dragging"); });
  for (const event of ["dragleave", "drop"]) zone.addEventListener(event, (e) => { e.preventDefault(); zone.classList.remove("dragging"); });
  zone.addEventListener("drop", (event) => chooseFile(event.dataTransfer.files[0], mode));
}

function updateProgress(mode, update) {
  const status = elements[`${mode}Status`];
  const text = elements[`${mode}StatusText`];
  const percent = elements[`${mode}Percent`];
  const bar = elements[`${mode}Progress`];
  status.hidden = false;
  const value = Math.max(0, Math.min(100, Math.round(update.progress * 100)));
  text.textContent = update.message;
  percent.textContent = `${value}%`;
  bar.style.width = `${value}%`;
}

function showError(error) {
  elements.toast.textContent = error instanceof Error ? error.message : String(error);
  elements.toast.hidden = false;
  clearTimeout(showError.timer);
  showError.timer = setTimeout(() => { elements.toast.hidden = true; }, 6500);
}

function renderPreview(indices, palette, resolution) {
  elements.canvas.width = resolution;
  elements.canvas.height = resolution;
  const context = elements.canvas.getContext("2d", { alpha: false });
  context.putImageData(new ImageData(paletteToRgba(palette, indices), resolution, resolution), 0, 0);
}

function addSummaryItem(list, term, description) {
  const wrapper = document.createElement("div");
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = term;
  dd.textContent = description;
  wrapper.append(dt, dd);
  list.append(wrapper);
}

elements.encodeButton.addEventListener("click", async () => {
  if (!sourceFile) return;
  elements.encodeButton.disabled = true;
  elements.encodeResult.hidden = true;
  try {
    const result = await encodeFileToApng(sourceFile, config(), paletteConfig(), (update) => updateProgress("encode", update));
    if (encodeUrl) URL.revokeObjectURL(encodeUrl);
    encodeUrl = URL.createObjectURL(result.blob);
    elements.apngDownload.href = encodeUrl;
    elements.apngDownload.download = `${sourceFile.name}.6d.apng`;
    renderPreview(result.firstFrameIndices, result.palette, result.capacity.resolution);
    const summary = $("#encode-summary");
    summary.replaceChildren();
    addSummaryItem(summary, "原始 / 压缩", `${formatBytes(result.originalSize)} / ${formatBytes(result.compressedSize)}`);
    addSummaryItem(summary, "APNG 大小", formatBytes(result.bytes.length));
    addSummaryItem(summary, "动画帧", `${result.frameCount} 帧 @ ${config().fps} fps`);
    addSummaryItem(summary, "SHA-256", `${bytesToHex(result.hash).slice(0, 20)}…`);
    elements.encodeResult.hidden = false;
    elements.encodeResult.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) { showError(error); }
  finally { elements.encodeButton.disabled = false; }
});

elements.decodeButton.addEventListener("click", async () => {
  if (!apngFile) return;
  elements.decodeButton.disabled = true;
  elements.decodeResult.hidden = true;
  try {
    const result = await decodeApng(await apngFile.arrayBuffer(), (update) => updateProgress("decode", update));
    if (decodeUrl) URL.revokeObjectURL(decodeUrl);
    decodeUrl = URL.createObjectURL(new Blob([result.bytes], { type: result.type || "application/octet-stream" }));
    elements.fileDownload.href = decodeUrl;
    elements.fileDownload.download = result.name || "decoded.bin";
    $("#decoded-name").textContent = result.name;
    $("#decoded-meta").textContent = `${formatBytes(result.originalSize)} · ${result.frameCount} 帧 · SHA-256 已通过`;
    elements.decodeResult.hidden = false;
  } catch (error) { showError(error); }
  finally { elements.decodeButton.disabled = false; }
});

for (const element of [elements.resolution, elements.cellSize, elements.fps, elements.hue, elements.saturation, elements.lightness, elements.contrast]) element.addEventListener("input", updateControls);
$("#palette-reset").addEventListener("click", () => {
  elements.hue.value = 198;
  elements.saturation.value = 82;
  elements.lightness.value = 58;
  elements.contrast.value = 10;
  updateControls();
});

setupDropzone(elements.encodeDropzone, elements.encodeFile, "encode");
setupDropzone(elements.decodeDropzone, elements.decodeFile, "decode");
updateControls();
