/*
 * Browser-facing analysis engine: rasterizes the glyph contour, runs the pure
 * mask analysis, and caches both analysis and rendered heatmap images.
 */

import {
  QUALITY_DIMENSIONS,
  analysisSignature,
  analyzeMask,
  clamp,
  estimateThicknessesFromAnalysis,
  normalizeSettings,
  renderSignature,
  summarizeSamples,
} from "./core.js";
import { renderHeatmapRGBA } from "./colormap.js";
import { groupContourSources } from "./elements.js";

const MAX_RENDER_CACHE_ENTRIES = 6;
const RASTER_MARGIN = 6;
// Extra transparent padding around an element crop. It must cover the largest
// blur, direction and corner-scan radius used by the analysis.
const ELEMENT_MARGIN = 32;
const OTHER_ELEMENT_ALPHA = 0.12;

function rasterGeometry(bounds, settings) {
  const boundsWidth = bounds.xMax - bounds.xMin;
  const boundsHeight = bounds.yMax - bounds.yMin;
  const maxDimension = QUALITY_DIMENSIONS[settings.quality];
  const scale = maxDimension / Math.max(boundsWidth, boundsHeight);
  const width = Math.max(8, Math.ceil(boundsWidth * scale) + 2 * RASTER_MARGIN);
  const height = Math.max(
    8,
    Math.ceil(boundsHeight * scale) + 2 * RASTER_MARGIN
  );
  return {
    scale,
    width,
    height,
    originX: bounds.xMin - RASTER_MARGIN / scale,
    originY: bounds.yMin - RASTER_MARGIN / scale,
    bounds,
  };
}

function createCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function readMask(context, width, height) {
  const imageData = context.getImageData(0, 0, width, height);
  const mask = new Uint8Array(width * height);
  let inkPixels = 0;
  for (let i = 0; i < mask.length; i++) {
    if (imageData.data[i * 4 + 3] >= 128) {
      mask[i] = 1;
      inkPixels++;
    }
  }
  return { mask, inkPixels };
}

function mergeElementSamples(elements, fullWidth) {
  let total = 0;
  for (const element of elements) {
    if (element.analysis) {
      total += element.analysis.samples.pointCount;
    }
  }

  const merged = {
    pixel: new Int32Array(total),
    x: new Float32Array(total),
    y: new Float32Array(total),
    nx: new Float32Array(total),
    ny: new Float32Array(total),
    tangent: new Float32Array(total),
    actual: new Float32Array(total),
    target: new Float32Array(total),
    deviation: new Float32Array(total),
    confidence: new Float32Array(total),
    pointCount: total,
  };

  let offset = 0;
  for (const element of elements) {
    if (!element.analysis) {
      continue;
    }
    const samples = element.analysis.samples;
    const count = samples.pointCount;
    for (const key of [
      "nx",
      "ny",
      "tangent",
      "actual",
      "target",
      "deviation",
      "confidence",
    ]) {
      merged[key].set(samples[key].subarray(0, count), offset);
    }
    // Element samples live in crop coordinates. Shift them into the composite
    // raster so the merged sample set is coherent with `analysis.width`.
    for (let i = 0; i < count; i++) {
      const x = samples.x[i] + element.x0;
      const y = samples.y[i] + element.y0;
      merged.x[offset + i] = x;
      merged.y[offset + i] = y;
      merged.pixel[offset + i] = y * fullWidth + x;
    }
    offset += count;
  }
  return merged;
}

function resolveElementFocus(analysis, settings, options) {
  const all = { all: true, indices: new Set(), key: "all" };
  if (settings.elementFocus === "all" || !analysis.elements?.length) {
    return all;
  }

  const indices = new Set();

  if (settings.elementFocus === "selected") {
    for (const item of options.selection || []) {
      if (typeof item !== "string") {
        continue;
      }
      const slash = item.indexOf("/");
      if (slash < 0) {
        continue;
      }
      const type = item.slice(0, slash);
      const index = Number(item.slice(slash + 1));
      if (!Number.isInteger(index)) {
        continue;
      }
      if (type === "point") {
        // Fontra's `point/<i>` selection uses an absolute point index, not a
        // contour index. The point map turns it into the element that owns the
        // contour.
        const elementIndex = analysis.pointToElement?.[index];
        if (elementIndex != null && elementIndex >= 0) {
          indices.add(elementIndex);
        }
      } else if (type.startsWith("component")) {
        for (const elementIndex of analysis.componentToElements?.[index] || []) {
          indices.add(elementIndex);
        }
      }
    }
  } else if (settings.elementFocus === "hovered") {
    const hitContourIndex = options.hoverPathHit?.contourIndex;
    if (Number.isInteger(hitContourIndex)) {
      const elementIndex =
        analysis.contourToElement?.[hitContourIndex] ??
        analysis.flattenedContourToElement?.[hitContourIndex];
      if (elementIndex != null && elementIndex >= 0) {
        indices.add(elementIndex);
      }
    }

    if (!indices.size) {
      for (const item of options.hoverSelection || []) {
        if (typeof item !== "string") {
          continue;
        }
        const slash = item.indexOf("/");
        if (slash < 0) {
          continue;
        }
        const type = item.slice(0, slash);
        const index = Number(item.slice(slash + 1));
        if (!Number.isInteger(index)) {
          continue;
        }
        if (type === "point") {
          const elementIndex = analysis.pointToElement?.[index];
          if (elementIndex != null && elementIndex >= 0) {
            indices.add(elementIndex);
          }
        } else if (type.startsWith("component")) {
          for (const elementIndex of analysis.componentToElements?.[index] || []) {
            indices.add(elementIndex);
          }
        }
      }
    }

    if (!indices.size && options.glyphPoint) {
      const elementIndex = hitTestElement(analysis, options.glyphPoint);
      if (elementIndex >= 0) {
        indices.add(elementIndex);
      }
    }
  }

  if (!indices.size) {
    return all;
  }

  const sorted = [...indices].sort((a, b) => a - b);
  return {
    all: false,
    indices,
    key: `${settings.elementFocus}:${sorted.join(",")}`,
  };
}

function hitTestElement(analysis, glyphPoint) {
  const x = (glyphPoint.x - analysis.originX) * analysis.scale;
  const y = (glyphPoint.y - analysis.originY) * analysis.scale;
  for (let i = analysis.elements.length - 1; i >= 0; i--) {
    const element = analysis.elements[i];
    const elementAnalysis = element.analysis;
    if (!elementAnalysis) {
      continue;
    }
    const localX = Math.floor(x - element.x0);
    const localY = Math.floor(y - element.y0);
    if (
      localX < 0 ||
      localY < 0 ||
      localX >= elementAnalysis.width ||
      localY >= elementAnalysis.height
    ) {
      continue;
    }
    if (elementAnalysis.mask[localY * elementAnalysis.width + localX]) {
      return element.index;
    }
  }
  return -1;
}

export class ThicknessEngine {
  constructor() {
    this._pathCache = new WeakMap();
    this._listeners = new Set();
    this._lastEmittedAnalysis = undefined;
    this.lastAnalysis = null;
  }

  addListener(listener) {
    this._listeners.add(listener);
  }

  removeListener(listener) {
    this._listeners.delete(listener);
  }

  _emit(analysis) {
    if (analysis === this._lastEmittedAnalysis) {
      return;
    }
    this._lastEmittedAnalysis = analysis;
    this.lastAnalysis = analysis;
    for (const listener of this._listeners) {
      listener(analysis);
    }
  }

  clear() {
    this._pathCache = new WeakMap();
    this._emit(null);
  }

  getAnalysis(positionedGlyph, settings) {
    const glyph = positionedGlyph?.glyph;
    const path = glyph?.flattenedPath2d;
    const bounds = positionedGlyph?.unpositionedBounds || glyph?.controlBounds;
    if (
      !path ||
      !bounds ||
      !Number.isFinite(bounds.xMin) ||
      !Number.isFinite(bounds.yMin) ||
      bounds.xMax - bounds.xMin <= 0 ||
      bounds.yMax - bounds.yMin <= 0
    ) {
      this._emit(null);
      return null;
    }

    const normalized = normalizeSettings(settings);
    const signature = `${analysisSignature(normalized)}|${bounds.xMin.toFixed(
      3
    )},${bounds.yMin.toFixed(3)},${bounds.xMax.toFixed(3)},${bounds.yMax.toFixed(3)}`;

    let cached = this._pathCache.get(path);
    if (cached?.signature === signature) {
      this._emit(cached.analysis);
      return cached.analysis;
    }

    const analysis = this._analyze(path, bounds, normalized, glyph);
    if (!analysis) {
      this._emit(null);
      return null;
    }

    cached = { signature, analysis };
    this._pathCache.set(path, cached);
    this._emit(analysis);
    return analysis;
  }

  _analyze(path, bounds, settings, glyph) {
    const geometry = rasterGeometry(bounds, settings);
    const blurRadius = clamp(
      Math.round(Math.min(geometry.width, geometry.height) / 120),
      3,
      8
    );

    if (settings.perElement && glyph?.path) {
      const perElement = this._analyzeElements(
        glyph,
        bounds,
        settings,
        geometry,
        blurRadius
      );
      if (perElement) {
        return perElement;
      }
    }

    const canvas = createCanvas(geometry.width, geometry.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      return null;
    }

    context.clearRect(0, 0, geometry.width, geometry.height);
    // Deliberately map glyph y-up to increasing raster rows: when the finished
    // image is drawn into Fontra's y-up canvas it is flipped back correctly.
    context.setTransform(
      geometry.scale,
      0,
      0,
      geometry.scale,
      RASTER_MARGIN - bounds.xMin * geometry.scale,
      RASTER_MARGIN - bounds.yMin * geometry.scale
    );
    context.fillStyle = "#fff";
    context.fill(path);

    const { mask, inkPixels } = readMask(
      context,
      geometry.width,
      geometry.height
    );
    if (!inkPixels) {
      return null;
    }

    const analysis = analyzeMask(
      mask,
      geometry.width,
      geometry.height,
      settings,
      geometry.scale,
      { blurRadius }
    );
    analysis.originX = geometry.originX;
    analysis.originY = geometry.originY;
    analysis.physicalWidth = geometry.width / geometry.scale;
    analysis.physicalHeight = geometry.height / geometry.scale;
    analysis.bounds = bounds;
    analysis.renderCache = new Map();
    return analysis;
  }

  _analyzeElements(glyph, bounds, settings, geometry, blurRadius) {
    const sources = [{ path: glyph.path, componentIndex: null }];
    for (let i = 0; i < (glyph.components?.length || 0); i++) {
      const component = glyph.components[i];
      if (component?.path?.numContours) {
        sources.push({ path: component.path, componentIndex: i });
      }
    }

    const grouped = groupContourSources(sources);
    if (!grouped.elements.length) {
      return null;
    }

    // Fontra selections address points by absolute point index. Build a map
    // from every point of the glyph's own path to the element that owns its
    // contour, so `point/<i>` focuses the right shape.
    const pointToElement = [];
    if (glyph.path?.numContours) {
      let start = 0;
      for (let contourIndex = 0; contourIndex < glyph.path.numContours; contourIndex++) {
        const endPoint = glyph.path.contourInfo?.[contourIndex]?.endPoint;
        const stop = Number.isInteger(endPoint) ? endPoint : start;
        const elementIndex = grouped.contourToElement[contourIndex] ?? -1;
        for (let pointIndex = start; pointIndex <= stop; pointIndex++) {
          pointToElement[pointIndex] = elementIndex;
        }
        start = stop + 1;
      }
    }

    const elements = grouped.elements.map((element) => {
      const result = {
        ...element,
        analysis: null,
        x0: 0,
        y0: 0,
      };
      result.analysis = this._analyzeElement(
        result,
        bounds,
        settings,
        geometry,
        blurRadius
      );
      return result;
    });

    const n = geometry.width * geometry.height;
    const mask = new Uint8Array(n);
    const boundary = new Uint8Array(n);
    const owner = new Int32Array(n);
    owner.fill(-1);
    const ownerWithValue = new Int32Array(n);
    ownerWithValue.fill(-1);

    for (const element of elements) {
      const elementAnalysis = element.analysis;
      if (!elementAnalysis) {
        continue;
      }
      const elementMask = elementAnalysis.mask;
      const pixels = elementAnalysis.pixels;
      for (let y = 0; y < elementAnalysis.height; y++) {
        const fullY = element.y0 + y;
        if (fullY < 0 || fullY >= geometry.height) {
          continue;
        }
        for (let x = 0; x < elementAnalysis.width; x++) {
          const localIndex = y * elementAnalysis.width + x;
          if (!elementMask[localIndex]) {
            continue;
          }
          const fullX = element.x0 + x;
          if (fullX < 0 || fullX >= geometry.width) {
            continue;
          }
          const fullIndex = fullY * geometry.width + fullX;
          mask[fullIndex] = 1;
          owner[fullIndex] = element.index;
          if (
            pixels.actual[localIndex] > 0 ||
            (pixels.fallbackActual?.[localIndex] ?? 0) > 0
          ) {
            ownerWithValue[fullIndex] = element.index;
          }
        }
      }
      const elementBoundary = elementAnalysis.boundary;
      for (let y = 0; y < elementAnalysis.height; y++) {
        const fullY = element.y0 + y;
        if (fullY < 0 || fullY >= geometry.height) {
          continue;
        }
        for (let x = 0; x < elementAnalysis.width; x++) {
          if (!elementBoundary[y * elementAnalysis.width + x]) {
            continue;
          }
          const fullX = element.x0 + x;
          if (fullX >= 0 && fullX < geometry.width) {
            boundary[fullY * geometry.width + fullX] = 1;
          }
        }
      }
    }

    const pixels = {
      actual: new Float32Array(n),
      target: new Float32Array(n),
      confidence: new Float32Array(n),
      fallbackActual: new Float32Array(n),
      fallbackTarget: new Float32Array(n),
    };

    for (let fullIndex = 0; fullIndex < n; fullIndex++) {
      let elementIndex = ownerWithValue[fullIndex];
      if (elementIndex < 0) {
        elementIndex = owner[fullIndex];
      }
      if (elementIndex < 0) {
        continue;
      }
      const element = elements[elementIndex];
      const elementAnalysis = element.analysis;
      const localX = (fullIndex % geometry.width) - element.x0;
      const localY = Math.floor(fullIndex / geometry.width) - element.y0;
      if (
        localX < 0 ||
        localY < 0 ||
        localX >= elementAnalysis.width ||
        localY >= elementAnalysis.height
      ) {
        continue;
      }
      const localIndex = localY * elementAnalysis.width + localX;
      const elementPixels = elementAnalysis.pixels;
      pixels.actual[fullIndex] = elementPixels.actual[localIndex];
      pixels.target[fullIndex] = elementPixels.target[localIndex];
      pixels.confidence[fullIndex] = elementPixels.confidence[localIndex];
      if (elementPixels.fallbackActual) {
        pixels.fallbackActual[fullIndex] =
          elementPixels.fallbackActual[localIndex];
      }
      if (elementPixels.fallbackTarget) {
        pixels.fallbackTarget[fullIndex] =
          elementPixels.fallbackTarget[localIndex];
      }
    }

    const mergedSamples = mergeElementSamples(elements, geometry.width);
    const stats = summarizeSamples(mergedSamples, settings.tolerance);

    return {
      width: geometry.width,
      height: geometry.height,
      scale: geometry.scale,
      mask,
      boundary,
      pixels,
      stats,
      samples: mergedSamples,
      originX: geometry.originX,
      originY: geometry.originY,
      physicalWidth: geometry.width / geometry.scale,
      physicalHeight: geometry.height / geometry.scale,
      bounds,
      elements,
      contourToElement: grouped.contourToElement,
      pointToElement,
      componentToElements: grouped.componentToElements,
      flattenedContourToElement: grouped.flattenedContourToElement,
      perElement: true,
      renderCache: new Map(),
    };
  }

  _analyzeElement(element, bounds, settings, geometry, blurRadius) {
    const elementBounds = element.bounds;
    if (!elementBounds) {
      return null;
    }

    const scale = geometry.scale;
    const x0 =
      Math.floor((elementBounds.xMin - bounds.xMin) * scale) +
      RASTER_MARGIN -
      ELEMENT_MARGIN;
    const y0 =
      Math.floor((elementBounds.yMin - bounds.yMin) * scale) +
      RASTER_MARGIN -
      ELEMENT_MARGIN;
    const x1 =
      Math.ceil((elementBounds.xMax - bounds.xMin) * scale) +
      RASTER_MARGIN +
      ELEMENT_MARGIN;
    const y1 =
      Math.ceil((elementBounds.yMax - bounds.yMin) * scale) +
      RASTER_MARGIN +
      ELEMENT_MARGIN;
    const width = Math.max(8, x1 - x0);
    const height = Math.max(8, y1 - y0);

    const path2d = new Path2D();
    for (const contour of element.solidContours) {
      contour.path.drawContourToPath2d(path2d, contour.contourIndex);
    }
    for (const contour of element.holeContours) {
      contour.path.drawContourToPath2d(path2d, contour.contourIndex);
    }

    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      return null;
    }
    context.clearRect(0, 0, width, height);
    context.setTransform(
      scale,
      0,
      0,
      scale,
      RASTER_MARGIN - bounds.xMin * scale - x0,
      RASTER_MARGIN - bounds.yMin * scale - y0
    );
    context.fillStyle = "#fff";
    context.fill(path2d);

    const { mask, inkPixels } = readMask(context, width, height);
    if (!inkPixels) {
      return null;
    }

    const analysis = analyzeMask(
      mask,
      width,
      height,
      settings,
      scale,
      { blurRadius }
    );
    analysis.originX = geometry.originX + x0 / scale;
    analysis.originY = geometry.originY + y0 / scale;
    analysis.physicalWidth = width / scale;
    analysis.physicalHeight = height / scale;
    analysis.bounds = bounds;
    analysis.renderCache = new Map();
    element.x0 = x0;
    element.y0 = y0;
    return analysis;
  }

  getImage(analysis, settings, options = {}) {
    if (!analysis) {
      return null;
    }
    const normalized = normalizeSettings(settings);
    if (analysis.elements && normalized.perElement) {
      return this._getElementImage(analysis, normalized, options);
    }

    const signature = renderSignature(normalized);
    const cached = analysis.renderCache.get(signature);
    if (cached) {
      return cached;
    }

    const { data, width, height } = renderHeatmapRGBA(analysis, normalized);
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }
    const imageData = context.createImageData(width, height);
    imageData.data.set(data);
    context.putImageData(imageData, 0, 0);

    analysis.renderCache.set(signature, canvas);
    while (analysis.renderCache.size > MAX_RENDER_CACHE_ENTRIES) {
      analysis.renderCache.delete(analysis.renderCache.keys().next().value);
    }
    return canvas;
  }

  _getElementImage(analysis, settings, options) {
    const focus = resolveElementFocus(analysis, settings, options);
    const signature = `${renderSignature(settings)}|${focus.key}`;
    const cached = analysis.renderCache.get(signature);
    if (cached) {
      return cached;
    }

    const canvas = createCanvas(analysis.width, analysis.height);
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }

    // Draw the non-focused elements first so the focused element stays on top
    // even when it is earlier in the contour order.
    const order = [];
    for (let i = 0; i < analysis.elements.length; i++) {
      if (!focus.all && !focus.indices.has(i)) {
        order.push(i);
      }
    }
    for (let i = 0; i < analysis.elements.length; i++) {
      if (focus.all || focus.indices.has(i)) {
        order.push(i);
      }
    }

    for (const elementIndex of order) {
      const element = analysis.elements[elementIndex];
      if (!element.analysis) {
        continue;
      }
      const isFocused = focus.all || focus.indices.has(elementIndex);
      const alpha = isFocused
        ? 1
        : settings.fadeOtherElements
          ? OTHER_ELEMENT_ALPHA
          : 0;
      if (alpha <= 0) {
        continue;
      }
      const image = this._getElementCanvas(element, settings, analysis.stats);
      if (!image) {
        continue;
      }
      context.globalAlpha = alpha;
      context.drawImage(image, element.x0, element.y0);
    }
    context.globalAlpha = 1;

    analysis.renderCache.set(signature, canvas);
    while (analysis.renderCache.size > MAX_RENDER_CACHE_ENTRIES) {
      analysis.renderCache.delete(analysis.renderCache.keys().next().value);
    }
    return canvas;
  }

  _getElementCanvas(element, settings, stats) {
    const statsKey = [
      stats.actualMin,
      stats.actualMax,
      stats.targetMin,
      stats.targetMax,
    ]
      .map((value) => Number(value).toFixed(4))
      .join(",");
    const signature = `${renderSignature(settings)}|${statsKey}`;
    const cached = element.analysis.renderCache.get(signature);
    if (cached) {
      return cached;
    }

    const { data, width, height } = renderHeatmapRGBA(
      element.analysis,
      settings,
      stats
    );
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }
    const imageData = context.createImageData(width, height);
    imageData.data.set(data);
    context.putImageData(imageData, 0, 0);

    element.analysis.renderCache.set(signature, canvas);
    while (element.analysis.renderCache.size > MAX_RENDER_CACHE_ENTRIES) {
      element.analysis.renderCache.delete(
        element.analysis.renderCache.keys().next().value
      );
    }
    return canvas;
  }

  fitThicknesses(positionedGlyph, settings) {
    const analysis = this.getAnalysis(positionedGlyph, settings);
    return estimateThicknessesFromAnalysis(analysis);
  }
}

export const thicknessEngine = new ThicknessEngine();
