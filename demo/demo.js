import {
  analyzeMask,
  estimateThicknessesFromAnalysis,
  modelLabel,
  normalizeSettings,
} from "../src/core.js";
import {
  deviationGradientCSS,
  legendModel,
  renderHeatmapRGBA,
  sequentialGradientCSS,
} from "../src/colormap.js";

const CANVAS_SIZE = 800;
const TEXT_SIZE = 620;
const FONT_FAMILIES = {
  B: "Georgia, 'Times New Roman', serif",
  S: "Georgia, 'Times New Roman', serif",
  O: "Georgia, 'Times New Roman', serif",
  H: "Arial, Helvetica, sans-serif",
  n: "Georgia, 'Times New Roman', serif",
};

const glyphSelect = document.querySelector("#glyph");
const modelSelect = document.querySelector("#model");
const angleInput = document.querySelector("#angle");
const horizontalInput = document.querySelector("#horizontal");
const displaySelect = document.querySelector("#display");
const angleLabel = document.querySelector("#angle-label");
const horizontalLabel = document.querySelector("#horizontal-label");
const originalCanvas = document.querySelector("#original");
const heatmapCanvas = document.querySelector("#heatmap");
const originalCaption = document.querySelector("#original-caption");
const heatmapCaption = document.querySelector("#heatmap-caption");
const legendBar = document.querySelector("#legend-bar");
const legendLabels = document.querySelector("#legend-labels");
const legendNote = document.querySelector("#legend-note");
const statsElement = document.querySelector("#stats");

const offscreen = document.createElement("canvas");
offscreen.width = CANVAS_SIZE;
offscreen.height = CANVAS_SIZE;
const offscreenContext = offscreen.getContext("2d", { willReadFrequently: true });

let scheduled = false;
let baseThickness = null;
let horizontalThickness = null;

function isDarkMode() {
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

function currentSettings() {
  const modelType = modelSelect.value;
  return normalizeSettings({
    modelType,
    penAngle: Number(angleInput.value),
    expansionHorizontal:
      horizontalThickness || Number(horizontalInput.value) || 35,
    baseThickness: baseThickness || 100,
    displayMode: displaySelect.value,
    tolerance: 5,
    scaleRange: 25,
    opacity: 0.82,
    quality: "balanced",
    palette: "accessible",
    fadeLowConfidence: true,
  });
}

function drawText(context, fillStyle) {
  context.save();
  context.fillStyle = fillStyle;
  context.font = `600 ${TEXT_SIZE}px ${FONT_FAMILIES[glyphSelect.value]}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(glyphSelect.value, CANVAS_SIZE / 2, CANVAS_SIZE / 2);
  context.restore();
}

function drawOriginal(settings) {
  const context = originalCanvas.getContext("2d");
  context.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  const dark = isDarkMode();
  context.fillStyle = dark ? "#1d1f21" : "#fbfbfb";
  context.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  drawText(context, dark ? "#e8eaed" : "#1f2933");
  originalCaption.textContent = `${glyphSelect.value} — ${modelLabel(
    settings.modelType
  )}`;
}

function makeMask() {
  offscreenContext.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  drawText(offscreenContext, "#fff");
  const pixels = offscreenContext.getImageData(
    0,
    0,
    CANVAS_SIZE,
    CANVAS_SIZE
  ).data;
  const mask = new Uint8Array(CANVAS_SIZE * CANVAS_SIZE);
  for (let displayY = 0; displayY < CANVAS_SIZE; displayY++) {
    const maskY = CANVAS_SIZE - 1 - displayY;
    for (let x = 0; x < CANVAS_SIZE; x++) {
      const displayIndex = displayY * CANVAS_SIZE + x;
      if (pixels[displayIndex * 4 + 3] >= 128) {
        mask[maskY * CANVAS_SIZE + x] = 1;
      }
    }
  }
  return mask;
}

function drawHeatmap(analysis, settings) {
  const context = heatmapCanvas.getContext("2d");
  const dark = isDarkMode();
  context.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  context.fillStyle = dark ? "#1d1f21" : "#fbfbfb";
  context.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  // Faint silhouette under the heat colors. This mimics the editing view the
  // plugin layer is composited over; without it, neutral areas would read as
  // holes instead of simply transparent.
  drawText(context, dark ? "#4a525a" : "#d4d9de");

  const { data, width, height } = renderHeatmapRGBA(analysis, settings);
  const displayData = new ImageData(width, height);
  for (let displayY = 0; displayY < height; displayY++) {
    const sourceY = height - 1 - displayY;
    for (let x = 0; x < width; x++) {
      const source = (sourceY * width + x) * 4;
      const target = (displayY * width + x) * 4;
      displayData.data[target] = data[source];
      displayData.data[target + 1] = data[source + 1];
      displayData.data[target + 2] = data[source + 2];
      displayData.data[target + 3] = data[source + 3];
    }
  }

  const imageCanvas = document.createElement("canvas");
  imageCanvas.width = width;
  imageCanvas.height = height;
  imageCanvas.getContext("2d").putImageData(displayData, 0, 0);
  context.drawImage(imageCanvas, 0, 0);

  context.save();
  context.strokeStyle = dark ? "#f4f5f6" : "#24292e";
  context.lineWidth = 1.3;
  context.font = `600 ${TEXT_SIZE}px ${FONT_FAMILIES[glyphSelect.value]}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.strokeText(glyphSelect.value, CANVAS_SIZE / 2, CANVAS_SIZE / 2);
  context.restore();

  heatmapCaption.textContent = `${displayLabel(settings.displayMode)} — ${modelLabel(
    settings.modelType
  )}`;
}

function displayLabel(mode) {
  return {
    deviation: "Deviation from model",
    target: "Model target thickness",
    measured: "Measured thickness",
    outliers: "Outliers beyond tolerance",
  }[mode];
}

function updateLegend(analysis, settings) {
  const legend = legendModel(analysis, settings);
  const [left, middle, right] = legendLabels.children;
  if (legend.kind === "sequential") {
    legendBar.style.background = sequentialGradientCSS("viridis");
    left.textContent = legend.min.toFixed(0);
    middle.textContent = ((legend.min + legend.max) / 2).toFixed(0);
    right.textContent = legend.max.toFixed(0);
    legendNote.textContent =
      settings.displayMode === "measured"
        ? "Measured caliper width in demo pixels, independent of the model."
        : "Thickness predicted by the selected model across this glyph. Values in demo pixels.";
  } else {
    legendBar.style.background = deviationGradientCSS(settings.palette);
    left.textContent = `${legend.min.toFixed(0)}%`;
    middle.textContent = "0%";
    right.textContent = `+${legend.max.toFixed(0)}%`;
    legendNote.textContent = `Cool = thinner than model; warm = thicker. Deviations within ±${settings.tolerance}% are kept neutral; low-confidence junctions and terminals fade back.`;
  }
}

function updateStats(analysis, settings) {
  const stats = analysis.stats;
  const rows = [
    ["Measured median", `${stats.actualMedian.toFixed(1)} px`],
    ["Model target", `${stats.targetMedian.toFixed(1)} px`],
    ["Median deviation", `${stats.deviationMedian > 0 ? "+" : ""}${stats.deviationMedian.toFixed(1)}%`],
    [
      "Deviation range",
      `${stats.deviationP10 > 0 ? "+" : ""}${stats.deviationP10.toFixed(0)} … ${
        stats.deviationP90 > 0 ? "+" : ""
      }${stats.deviationP90.toFixed(0)}%`,
    ],
    ["Within tolerance", `${stats.withinPercent.toFixed(0)}%`],
    [
      "Thicker / thinner",
      `${stats.thickPercent.toFixed(0)}% / ${stats.thinPercent.toFixed(0)}%`,
    ],
    ["Contour samples", stats.count.toLocaleString()],
    ["Vertical target", `${settings.baseThickness.toFixed(1)} px`],
  ];
  if (settings.modelType === "expansion") {
    rows.push([
      "Horizontal target",
      `${settings.expansionHorizontal.toFixed(1)} px`,
    ]);
  }
  statsElement.replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const labelElement = document.createElement("div");
      labelElement.textContent = label;
      const valueElement = document.createElement("div");
      valueElement.textContent = value;
      return [labelElement, valueElement];
    })
  );
}

function render() {
  scheduled = false;
  let settings = currentSettings();
  const isExpansion = settings.modelType === "expansion";

  angleLabel.childNodes[0].textContent = `Pen angle · ${Number(
    angleInput.value
  )}°`;
  horizontalLabel.childNodes[0].textContent = `Horizontal thickness · ${Math.round(
    horizontalThickness || Number(horizontalInput.value)
  )} px`;
  angleLabel.style.display =
    settings.modelType === "translation" ? "grid" : "none";
  horizontalLabel.style.display = isExpansion ? "grid" : "none";

  const mask = makeMask();
  let analysis = analyzeMask(mask, CANVAS_SIZE, CANVAS_SIZE, settings, 1);

  if (!baseThickness || !horizontalThickness) {
    const fit = estimateThicknessesFromAnalysis(analysis);
    let changed = false;
    if (!baseThickness && fit?.vertical) {
      baseThickness = fit.vertical;
      changed = true;
    }
    if (!horizontalThickness) {
      const value = fit?.horizontal || Number(horizontalInput.value);
      if (value) {
        horizontalThickness = value;
        horizontalInput.value = Math.min(
          Number(horizontalInput.max),
          Math.round(value)
        );
        changed = true;
      }
    }
    if (changed) {
      settings = currentSettings();
      analysis = analyzeMask(mask, CANVAS_SIZE, CANVAS_SIZE, settings, 1);
    }
  }

  drawOriginal(settings);
  drawHeatmap(analysis, settings);
  updateLegend(analysis, settings);
  updateStats(analysis, settings);
}

function scheduleRender() {
  if (!scheduled) {
    scheduled = true;
    setTimeout(render, 0);
  }
}

glyphSelect.addEventListener("change", () => {
  baseThickness = null;
  horizontalThickness = null;
  scheduleRender();
});
modelSelect.addEventListener("change", () => {
  scheduleRender();
});
angleInput.addEventListener("input", scheduleRender);
horizontalInput.addEventListener("input", () => {
  horizontalThickness = Number(horizontalInput.value);
  scheduleRender();
});
displaySelect.addEventListener("change", scheduleRender);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", scheduleRender);

document.fonts.ready.then(() => {
  setTimeout(render, 0);
});
