/*
 * Browser-facing analysis engine: rasterizes the glyph contour, runs the pure
 * mask analysis, and caches both analysis and rendered heatmap images.
 */

import {
  QUALITY_DIMENSIONS,
  analysisSignature,
  analyzeMask,
  estimateThicknessesFromAnalysis,
  normalizeSettings,
  renderSignature,
} from "./core.js";
import { renderHeatmapRGBA } from "./colormap.js";

const MAX_RENDER_CACHE_ENTRIES = 6;
const RASTER_MARGIN = 6;

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

    const analysis = this._analyze(path, bounds, normalized);
    if (!analysis) {
      this._emit(null);
      return null;
    }

    cached = { signature, analysis };
    this._pathCache.set(path, cached);
    this._emit(analysis);
    return analysis;
  }

  _analyze(path, bounds, settings) {
    const boundsWidth = bounds.xMax - bounds.xMin;
    const boundsHeight = bounds.yMax - bounds.yMin;
    const maxDimension = QUALITY_DIMENSIONS[settings.quality];
    const scale = maxDimension / Math.max(boundsWidth, boundsHeight);
    const width = Math.max(8, Math.ceil(boundsWidth * scale) + 2 * RASTER_MARGIN);
    const height = Math.max(8, Math.ceil(boundsHeight * scale) + 2 * RASTER_MARGIN);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      return null;
    }

    context.clearRect(0, 0, width, height);
    // Deliberately map glyph y-up to increasing raster rows: when the finished
    // image is drawn into Fontra's y-up canvas it is flipped back correctly.
    context.setTransform(
      scale,
      0,
      0,
      scale,
      RASTER_MARGIN - bounds.xMin * scale,
      RASTER_MARGIN - bounds.yMin * scale
    );
    context.fillStyle = "#fff";
    context.fill(path);

    const imageData = context.getImageData(0, 0, width, height);
    const mask = new Uint8Array(width * height);
    let inkPixels = 0;
    for (let i = 0; i < mask.length; i++) {
      if (imageData.data[i * 4 + 3] >= 128) {
        mask[i] = 1;
        inkPixels++;
      }
    }
    if (!inkPixels) {
      return null;
    }

    const analysis = analyzeMask(mask, width, height, settings, scale);
    analysis.originX = bounds.xMin - RASTER_MARGIN / scale;
    analysis.originY = bounds.yMin - RASTER_MARGIN / scale;
    analysis.physicalWidth = width / scale;
    analysis.physicalHeight = height / scale;
    analysis.bounds = bounds;
    analysis.renderCache = new Map();
    return analysis;
  }

  getImage(analysis, settings) {
    if (!analysis) {
      return null;
    }
    const signature = renderSignature(settings);
    const cached = analysis.renderCache.get(signature);
    if (cached) {
      return cached;
    }

    const { data, width, height } = renderHeatmapRGBA(analysis, settings);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
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

  fitThicknesses(positionedGlyph, settings) {
    const analysis = this.getAnalysis(positionedGlyph, settings);
    return estimateThicknessesFromAnalysis(analysis);
  }
}

export const thicknessEngine = new ThicknessEngine();
