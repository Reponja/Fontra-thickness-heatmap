/* Color maps and pixel rendering for the thickness heatmap. */

import { clamp, deviationPercent, normalizeSettings } from "./core.js";

// Okabe-Ito-ish blue/orange: avoid red-green confusion.
const ACCESSIBLE_DIVERGING = [
  [0.0, "#0072b2"],
  [0.25, "#56b4e9"],
  [0.5, "#d9d9d9"],
  [0.75, "#f0a35e"],
  [1.0, "#d55e00"],
];

// A classic blue-white-red divergence.
const CLASSIC_DIVERGING = [
  [0.0, "#2166ac"],
  [0.25, "#92c5de"],
  [0.5, "#f7f7f7"],
  [0.75, "#f4a582"],
  [1.0, "#b2182b"],
];

const VIRIDIS = [
  [0.0, "#440154"],
  [0.25, "#3b528b"],
  [0.5, "#21918c"],
  [0.75, "#5ec962"],
  [1.0, "#fde725"],
];

export const DIVERGING_PALETTES = {
  accessible: ACCESSIBLE_DIVERGING,
  classic: CLASSIC_DIVERGING,
};

export const SEQUENTIAL_PALETTES = {
  viridis: VIRIDIS,
};

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

const RGB_PALETTES = Object.fromEntries(
  Object.entries({ ...DIVERGING_PALETTES, ...SEQUENTIAL_PALETTES }).map(
    ([name, stops]) => [name, stops.map(([position, color]) => [position, hexToRgb(color)])]
  )
);

function sampleRgbGradient(stops, t) {
  const value = clamp(t, 0, 1);
  for (let i = 1; i < stops.length; i++) {
    const [rightPosition, rightColor] = stops[i];
    if (value <= rightPosition) {
      const [leftPosition, leftColor] = stops[i - 1];
      const span = Math.max(rightPosition - leftPosition, 1e-6);
      const f = (value - leftPosition) / span;
      return [
        leftColor[0] + (rightColor[0] - leftColor[0]) * f,
        leftColor[1] + (rightColor[1] - leftColor[1]) * f,
        leftColor[2] + (rightColor[2] - leftColor[2]) * f,
      ];
    }
  }
  return stops[stops.length - 1][1];
}

export function divergingColor(t, palette = "accessible") {
  const stops = RGB_PALETTES[palette] || RGB_PALETTES.accessible;
  return sampleRgbGradient(stops, (clamp(t, -1, 1) + 1) / 2);
}

export function sequentialColor(t, palette = "viridis") {
  const stops = RGB_PALETTES[palette] || RGB_PALETTES.viridis;
  return sampleRgbGradient(stops, t);
}

export function deviationGradientCSS(palette = "accessible") {
  const stops = DIVERGING_PALETTES[palette] || DIVERGING_PALETTES.accessible;
  const parts = stops.map(([position, color]) => `${color} ${(position * 100).toFixed(1)}%`);
  return `linear-gradient(90deg, ${parts.join(", ")})`;
}

export function sequentialGradientCSS(palette = "viridis") {
  const stops = SEQUENTIAL_PALETTES[palette] || SEQUENTIAL_PALETTES.viridis;
  const parts = stops.map(([position, color]) => `${color} ${(position * 100).toFixed(1)}%`);
  return `linear-gradient(90deg, ${parts.join(", ")})`;
}

function normalizeRange(min, max) {
  if (max - min > 1e-6) {
    return [min, max];
  }
  const padding = Math.max(Math.abs(min) * 0.05, 1);
  return [min - padding, max + padding];
}

/**
 * Turn an analysis into a transparent RGBA image. The image uses the same
 * y-up row order as the mask; Fontra's y-up canvas will draw it correctly.
 */
export function renderHeatmapRGBA(analysis, settings) {
  const s = normalizeSettings(settings);
  const { width, height, mask, pixels, stats } = analysis;
  const data = new Uint8ClampedArray(width * height * 4);
  const scaleRange = Math.max(s.scaleRange, 0.001);
  const [actualMin, actualMax] = normalizeRange(stats.actualMin, stats.actualMax);
  const [targetMin, targetMax] = normalizeRange(stats.targetMin, stats.targetMax);
  const absoluteMode =
    s.displayMode === "target" || s.displayMode === "measured";

  for (let pixel = 0; pixel < mask.length; pixel++) {
    if (!mask[pixel]) {
      continue;
    }

    // Absolute modes are a measurement readout: every inked pixel should show
    // the nearest reliable thickness, even where careful mode rejected the
    // local chord. Confidence fading belongs to the deviation views.
    const confidence = pixels.confidence[pixel];
    if (!absoluteMode && !(confidence > 0)) {
      continue;
    }
    let actual = pixels.actual[pixel];
    let target = pixels.target[pixel];
    if (absoluteMode) {
      if (!(actual > 0) && pixels.fallbackActual) {
        actual = pixels.fallbackActual[pixel];
      }
      if (!(target > 0) && pixels.fallbackTarget) {
        target = pixels.fallbackTarget[pixel];
      }
    }
    if (!(actual > 0) || !(target > 0)) {
      continue;
    }
    const deviation = deviationPercent(actual, target);
    let r;
    let g;
    let b;
    let alpha;

    if (absoluteMode) {
      const measured = s.displayMode === "measured";
      const value = measured ? actual : target;
      const [min, max] = measured
        ? [actualMin, actualMax]
        : [targetMin, targetMax];
      const t = (value - min) / Math.max(max - min, 1e-6);
      [r, g, b] = sequentialColor(t);
      alpha = s.opacity * 0.82;
    } else {
      const t = clamp(deviation / scaleRange, -1, 1);
      [r, g, b] = divergingColor(t, s.palette);
      const inside = Math.abs(deviation) <= s.tolerance;
      if (inside) {
        // The tolerance band is a neutral zone in both deviation and
        // outliers mode. Keep it faint and desaturated so the band boundary
        // is visible without pretending the correction is an error.
        alpha = s.opacity * (s.displayMode === "outliers" ? 0.035 : 0.06);
        const gray = 128;
        const mix = 0.15;
        r = gray + (r - gray) * mix;
        g = gray + (g - gray) * mix;
        b = gray + (b - gray) * mix;
      } else {
        const outside = clamp(
          (Math.abs(deviation) - s.tolerance) /
            Math.max(s.scaleRange - s.tolerance, 1),
          0,
          1
        );
        alpha = s.opacity * (0.15 + 0.85 * outside);
      }
    }

    if (!absoluteMode && s.fadeLowConfidence) {
      const confidenceFactor = clamp(confidence / 0.45, 0, 1);
      const confidenceAlpha = 0.3 + 0.7 * confidenceFactor;
      alpha *= confidenceAlpha;
      if (confidenceFactor < 0.65) {
        const gray = 128;
        const mix = 0.35 + 0.65 * confidenceFactor;
        r = gray + (r - gray) * mix;
        g = gray + (g - gray) * mix;
        b = gray + (b - gray) * mix;
      }
    }

    const offset = pixel * 4;
    data[offset] = r;
    data[offset + 1] = g;
    data[offset + 2] = b;
    data[offset + 3] = clamp(alpha, 0, 1) * 255;
  }

  return { data, width, height };
}

export function legendModel(analysis, settings) {
  const s = normalizeSettings(settings);
  if (s.displayMode === "target" || s.displayMode === "measured") {
    const measured = s.displayMode === "measured";
    const min = measured ? analysis.stats.actualMin : analysis.stats.targetMin;
    const max = measured ? analysis.stats.actualMax : analysis.stats.targetMax;
    const [rangeMin, rangeMax] = normalizeRange(min, max);
    return {
      kind: "sequential",
      min: rangeMin,
      max: rangeMax,
      title: measured ? "Measured thickness" : "Model target thickness",
      units: "units",
    };
  }
  return {
    kind: "diverging",
    min: -s.scaleRange,
    max: s.scaleRange,
    title: s.displayMode === "outliers" ? "Outliers beyond tolerance" : "Deviation",
    units: "%",
    tolerance: s.tolerance,
  };
}
