import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeMask,
  analysisSignature,
  degToRad,
  estimateBaseFromAnalysis,
  extractBoundary,
  modelThicknessFactor,
  normalizeSettings,
  renderSignature,
} from "../src/core.js";
import {
  deviationGradientCSS,
  divergingColor,
  renderHeatmapRGBA,
  sequentialColor,
} from "../src/colormap.js";

function makeMask(width, height) {
  return new Uint8Array(width * height);
}

function fillRect(mask, width, xMin, yMin, xMax, yMax) {
  for (let y = yMin; y < yMax; y++) {
    for (let x = xMin; x < xMax; x++) {
      mask[y * width + x] = 1;
    }
  }
}

function findSampleNear(samples, x, y, radius = 2) {
  for (let i = 0; i < samples.pointCount; i++) {
    if (
      Math.abs(samples.x[i] - x) <= radius &&
      Math.abs(samples.y[i] - y) <= radius
    ) {
      return i;
    }
  }
  return -1;
}

function samplesInBox(samples, xMin, yMin, xMax, yMax) {
  const result = [];
  for (let i = 0; i < samples.pointCount; i++) {
    if (
      samples.x[i] >= xMin &&
      samples.x[i] <= xMax &&
      samples.y[i] >= yMin &&
      samples.y[i] <= yMax
    ) {
      result.push(i);
    }
  }
  return result;
}

test("translation model normalizes a vertical stem to the base thickness", () => {
  const settings = {
    modelType: "translation",
    penAngle: 30,
    translationMin: 0,
  };

  assert.equal(modelThicknessFactor(settings, degToRad(90)), 1);
  assert.ok(
    Math.abs(
      modelThicknessFactor(settings, degToRad(0)) - Math.sin(degToRad(30)) / Math.sin(degToRad(60))
    ) < 1e-9
  );
});

test("pen edge is the thinnest stroke as a fraction of vertical thickness", () => {
  const settings = {
    modelType: "translation",
    penAngle: 30,
    translationMin: 0.2,
  };
  const horizontal = modelThicknessFactor(settings, degToRad(0));
  const vertical = modelThicknessFactor(settings, degToRad(90));
  const thinnest = modelThicknessFactor(settings, degToRad(30));

  assert.equal(vertical, 1);
  assert.ok(Math.abs(thinnest - 0.2) < 1e-9);
  assert.ok(Math.abs(horizontal - (0.2 + 0.8 * Math.tan(degToRad(30)))) < 1e-9);
});

test("pen edge can exceed 100 percent and reverse the contrast", () => {
  const settings = normalizeSettings({
    modelType: "translation",
    penAngle: 30,
    translationMin: 1.5,
  });

  assert.equal(settings.translationMin, 1.5);
  assert.equal(modelThicknessFactor(settings, degToRad(90)), 1);
  assert.equal(modelThicknessFactor(settings, degToRad(30)), 1.5);
  assert.ok(
    modelThicknessFactor(settings, degToRad(120)) <
      modelThicknessFactor(settings, degToRad(90))
  );

  assert.equal(normalizeSettings({ translationMin: 100 }).translationMin, 10);
});

test("expansion uses vertical and horizontal targets directly", () => {
  const settings = {
    modelType: "expansion",
    baseThickness: 100,
    expansionHorizontal: 25,
  };

  assert.equal(modelThicknessFactor(settings, degToRad(90)), 1);
  assert.ok(Math.abs(modelThicknessFactor(settings, degToRad(0)) - 0.25) < 1e-9);
  assert.ok(
    Math.abs(modelThicknessFactor(settings, degToRad(45)) - 0.625) < 1e-9
  );
});

test("expansion supports horizontal strokes thicker than vertical", () => {
  const settings = {
    modelType: "expansion",
    baseThickness: 100,
    expansionHorizontal: 160,
  };

  assert.equal(modelThicknessFactor(settings, degToRad(90)), 1);
  assert.ok(Math.abs(modelThicknessFactor(settings, degToRad(0)) - 1.6) < 1e-9);
  assert.ok(
    Math.abs(modelThicknessFactor(settings, degToRad(45)) - 1.3) < 1e-9
  );
});

test("monoline model is flat", () => {
  for (const angle of [0, 20, 45, 90, 125]) {
    assert.equal(modelThicknessFactor({ modelType: "monoline" }, degToRad(angle)), 1);
  }
});

test("normalization constrains UI values to safe ranges", () => {
  const settings = normalizeSettings({
    baseThickness: 0,
    penAngle: 200,
    translationMin: -1,
    expansionHorizontal: 0,
    tolerance: -4,
    opacity: 4,
    quality: "nonsense",
  });

  assert.ok(settings.baseThickness > 0);
  assert.equal(settings.penAngle, 80);
  assert.equal(settings.translationMin, 0);
  assert.equal(settings.expansionHorizontal, 0.1);
  assert.equal(settings.tolerance, 0);
  assert.equal(settings.opacity, 1);
  assert.equal(settings.quality, "balanced");
});

test("extractBoundary finds only edge pixels", () => {
  const width = 12;
  const height = 12;
  const mask = makeMask(width, height);
  fillRect(mask, width, 3, 3, 9, 9);
  const boundary = extractBoundary(mask, width, height);

  assert.equal(boundary[3 * width + 3], 1);
  assert.equal(boundary[5 * width + 5], 0);
  assert.equal(boundary[0], 0);
});

test("vertical bar measures its width and normalizes to the base", () => {
  const width = 60;
  const height = 140;
  const mask = makeMask(width, height);
  fillRect(mask, width, 20, 20, 40, 120);

  const analysis = analyzeMask(
    mask,
    width,
    height,
    { modelType: "translation", penAngle: 30, baseThickness: 20 },
    1
  );

  assert.ok(analysis.samples.pointCount > 0);
  const side = findSampleNear(analysis.samples, 20, 70, 1);
  assert.notEqual(side, -1);
  assert.ok(Math.abs(analysis.samples.actual[side] - 20) < 0.01);
  assert.ok(Math.abs(analysis.samples.target[side] - 20) < 0.01);
  assert.ok(Math.abs(analysis.samples.deviation[side]) < 0.01);
  assert.ok(Math.abs(analysis.samples.tangent[side] - Math.PI / 2) < 0.02);
  assert.ok(analysis.samples.confidence[side] > 0.7);
  assert.equal(analysis.stats.withinPercent, 100);
});

test("horizontal bar is thicker than a 30-degree translation model predicts", () => {
  const width = 160;
  const height = 60;
  const mask = makeMask(width, height);
  fillRect(mask, width, 20, 20, 120, 40);

  const analysis = analyzeMask(
    mask,
    width,
    height,
    {
      modelType: "translation",
      penAngle: 30,
      translationMin: 0,
      baseThickness: 20,
    },
    1
  );

  const side = findSampleNear(analysis.samples, 70, 20, 1);
  assert.notEqual(side, -1);
  assert.ok(Math.abs(analysis.samples.actual[side] - 20) < 0.01);
  assert.ok(Math.abs(analysis.samples.target[side] - 20 * Math.sin(degToRad(30)) / Math.sin(degToRad(60))) < 0.01);
  assert.ok(analysis.samples.deviation[side] > 70);
  assert.ok(Math.abs(Math.sin(analysis.samples.tangent[side])) < 0.02);
});

test("base fitting uses near-vertical strokes", () => {
  const width = 60;
  const height = 140;
  const mask = makeMask(width, height);
  fillRect(mask, width, 20, 20, 40, 120);

  const analysis = analyzeMask(
    mask,
    width,
    height,
    { modelType: "translation", penAngle: 30, baseThickness: 100 },
    1
  );
  const estimate = estimateBaseFromAnalysis(analysis);
  assert.ok(estimate !== null);
  assert.ok(Math.abs(estimate - 20) < 0.2);
});

test("ring mask produces plausible thickness samples and no NaNs", () => {
  const width = 120;
  const height = 120;
  const mask = makeMask(width, height);
  const cx = 60;
  const cy = 60;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const distance = Math.hypot(x - cx, y - cy);
      if (distance >= 30 && distance <= 50) {
        mask[y * width + x] = 1;
      }
    }
  }

  const analysis = analyzeMask(
    mask,
    width,
    height,
    {
      modelType: "expansion",
      baseThickness: 20,
      expansionHorizontal: 5,
    },
    1
  );

  assert.ok(analysis.samples.pointCount > 0);
  assert.ok(analysis.stats.count > 0);
  for (let i = 0; i < analysis.samples.pointCount; i++) {
    assert.ok(Number.isFinite(analysis.samples.actual[i]));
    assert.ok(Number.isFinite(analysis.samples.target[i]));
    assert.ok(Number.isFinite(analysis.samples.deviation[i]));
    assert.ok(analysis.samples.confidence[i] >= 0);
    assert.ok(analysis.samples.confidence[i] <= 1);
  }

  const top = findSampleNear(analysis.samples, 60, 30, 3);
  assert.notEqual(top, -1);
  assert.ok(Math.abs(analysis.samples.actual[top] - 20) < 1.5);
});

test("ambiguous samples do not leak extreme widths into the pixel map", () => {
  // A plus sign has large, genuinely ambiguous calipers at the four inner
  // corners. They must not paint their widths into the crossing bars.
  const width = 160;
  const height = 160;
  const barWidth = 40;
  const mask = makeMask(width, height);
  fillRect(mask, width, 60, 20, 60 + barWidth, 140);
  fillRect(mask, width, 20, 60, 140, 60 + barWidth);

  const analysis = analyzeMask(
    mask,
    width,
    height,
    { modelType: "translation", penAngle: 30, baseThickness: barWidth },
    1
  );

  let maxAmbiguous = 0;
  for (let i = 0; i < analysis.samples.pointCount; i++) {
    if (analysis.samples.confidence[i] < 0.5) {
      maxAmbiguous = Math.max(maxAmbiguous, analysis.samples.actual[i]);
    }
  }
  assert.ok(maxAmbiguous > barWidth * 2);

  let maxPixel = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) {
      continue;
    }
    const seed = analysis.nearestConfidentSample[i];
    if (seed >= 0) {
      assert.ok(analysis.samples.confidence[seed] >= 0.5);
    }
    assert.ok(Number.isFinite(analysis.pixels.confidence[i]));
    if (analysis.pixels.actual[i] > 0) {
      assert.ok(Number.isFinite(analysis.pixels.target[i]));
      maxPixel = Math.max(maxPixel, analysis.pixels.actual[i]);
    }
  }
  assert.ok(maxPixel < barWidth * 1.5);
});

test("careful measurement rejects caliper chords at an inner junction", () => {
  const width = 160;
  const height = 160;
  const mask = makeMask(width, height);
  fillRect(mask, width, 20, 20, 45, 130);
  fillRect(mask, width, 20, 100, 120, 130);
  fillRect(mask, width, 95, 20, 120, 130);

  const settings = {
    modelType: "translation",
    penAngle: 30,
    baseThickness: 25,
  };
  const fast = analyzeMask(
    mask,
    width,
    height,
    { ...settings, carefulMeasurement: false },
    1
  );
  const careful = analyzeMask(
    mask,
    width,
    height,
    { ...settings, carefulMeasurement: true },
    1
  );

  const junctionBox = [42, 95, 50, 101];
  const fastMax = Math.max(
    ...samplesInBox(fast.samples, ...junctionBox)
      .filter((i) => fast.samples.confidence[i] >= 0.5)
      .map((i) => fast.samples.actual[i])
  );
  const carefulMax = Math.max(
    ...samplesInBox(careful.samples, ...junctionBox)
      .filter((i) => careful.samples.confidence[i] >= 0.5)
      .map((i) => careful.samples.actual[i])
  );

  // One-sided calipers see a 33-pixel chord across the junction; the
  // two-sided check rejects it instead of painting a false hot spot.
  assert.ok(fastMax >= 31);
  assert.ok(carefulMax <= 30.5);

  const stem = findSampleNear(careful.samples, 20, 60, 1);
  assert.notEqual(stem, -1);
  assert.ok(Math.abs(careful.samples.actual[stem] - 25) < 0.6);
  assert.ok(careful.samples.confidence[stem] > 0.9);
});

test("careful measurement keeps curved ring widths stable", () => {
  const width = 120;
  const height = 120;
  const mask = makeMask(width, height);
  const cx = 60;
  const cy = 60;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const distance = Math.hypot(x - cx, y - cy);
      if (distance >= 30 && distance <= 50) {
        mask[y * width + x] = 1;
      }
    }
  }

  const analysis = analyzeMask(
    mask,
    width,
    height,
    {
      modelType: "expansion",
      baseThickness: 20,
      expansionHorizontal: 5,
      carefulMeasurement: true,
    },
    1
  );

  const curved = samplesInBox(analysis.samples, 30, 10, 90, 60).filter(
    (i) => analysis.samples.confidence[i] >= 0.5
  );
  assert.ok(curved.length > 20);
  for (const i of curved) {
    assert.ok(Math.abs(analysis.samples.actual[i] - 20) < 2.5);
  }
});

test("tolerance band keeps small deviations neutral in deviation mode", () => {
  const width = 60;
  const height = 140;
  const mask = makeMask(width, height);
  fillRect(mask, width, 20, 20, 40, 120);
  const settings = {
    modelType: "monoline",
    baseThickness: 20.4,
    displayMode: "deviation",
    opacity: 0.8,
    scaleRange: 25,
    carefulMeasurement: true,
  };
  const analysis = analyzeMask(mask, width, height, settings, 1);

  const loose = renderHeatmapRGBA(analysis, { ...settings, tolerance: 5 });
  const tight = renderHeatmapRGBA(analysis, { ...settings, tolerance: 0 });
  const offset = (70 * width + 30) * 4;

  // A 2% deviation is inside the 5% band: it should be faint and gray.
  const looseAlpha = loose.data[offset + 3];
  const tightAlpha = tight.data[offset + 3];
  assert.ok(looseAlpha < tightAlpha * 0.5);
  const channels = [
    loose.data[offset],
    loose.data[offset + 1],
    loose.data[offset + 2],
  ];
  assert.ok(Math.max(...channels) - Math.min(...channels) < 20);
});

test("signatures ignore cosmetic settings but include analysis settings", () => {
  const settings = { baseThickness: 100, opacity: 0.5, quality: "balanced" };
  assert.equal(
    analysisSignature({ ...settings, opacity: 0.2 }),
    analysisSignature(settings)
  );
  assert.notEqual(
    analysisSignature({ ...settings, quality: "fine" }),
    analysisSignature(settings)
  );
  assert.notEqual(
    analysisSignature({ ...settings, expansionHorizontal: 45 }),
    analysisSignature(settings)
  );
  assert.notEqual(
    analysisSignature({ ...settings, carefulMeasurement: false }),
    analysisSignature(settings)
  );
  assert.notEqual(
    renderSignature({ ...settings, opacity: 0.2 }),
    renderSignature(settings)
  );
});

test("colormap endpoints and gradients are well formed", () => {
  const [thinR, thinG, thinB] = divergingColor(-1, "accessible");
  assert.ok(thinB > thinR);
  const [thickR, , thickB] = divergingColor(1, "accessible");
  assert.ok(thickR > thickB);

  const [seqR, seqG, seqB] = sequentialColor(1);
  assert.ok(seqR > 200 && seqG > 180 && seqB < 100);

  assert.match(deviationGradientCSS("classic"), /^linear-gradient/);
});

test("renderHeatmapRGBA leaves non-ink pixels transparent", () => {
  const width = 60;
  const height = 140;
  const mask = makeMask(width, height);
  fillRect(mask, width, 20, 20, 40, 120);
  const settings = {
    modelType: "translation",
    penAngle: 30,
    baseThickness: 20,
    displayMode: "deviation",
    opacity: 0.8,
  };
  const analysis = analyzeMask(mask, width, height, settings, 1);
  const image = renderHeatmapRGBA(analysis, settings);

  assert.equal(image.data.length, width * height * 4);
  assert.equal(image.data[3], 0);
  const inside = (70 * width + 30) * 4;
  assert.ok(image.data[inside + 3] > 0);
});
