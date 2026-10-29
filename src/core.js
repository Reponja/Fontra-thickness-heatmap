/*
 * Pure geometry, raster measurement, and model code for the thickness heatmap.
 *
 * The analysis works on a binary ink mask laid out in glyph coordinates:
 * x increases to the right, y increases upwards, and the first mask row is
 * the bottom row of the glyph. The RGBA image keeps that row order, so drawing
 * it into Fontra's y-up canvas maps it back onto the glyph without an extra
 * flip.
 */

export const MODEL_TYPES = ["translation", "expansion", "monoline"];
export const DISPLAY_MODES = ["deviation", "target", "measured", "outliers"];
export const ELEMENT_FOCUS_MODES = ["all", "selected", "hovered"];

export const QUALITY_DIMENSIONS = {
  fast: 320,
  balanced: 512,
  fine: 768,
};

// Samples below this confidence are excluded from statistics and thickness
// fitting. At and above the propagate threshold, a sample is also trusted as a
// seed for the per-pixel width field; ambiguous junction samples only affect
// the fade field, never the colors.
const CONFIDENCE_ACCEPT = 0.35;
const CONFIDENCE_PROPAGATE = 0.5;

export const DEFAULT_SETTINGS = {
  enabled: true,
  modelType: "translation",
  baseThickness: 100,
  penAngle: 30,
  translationMin: 0.08,
  expansionHorizontal: 35,
  displayMode: "deviation",
  tolerance: 5,
  scaleRange: 25,
  opacity: 0.78,
  quality: "balanced",
  palette: "accessible",
  fadeLowConfidence: true,
  carefulMeasurement: true,
  perElement: false,
  elementFocus: "all",
  fadeOtherElements: true,
  flowGuideMode: "across",
  useFlowGuides: true,
  showFlowGuides: true,
};

const DEG = Math.PI / 180;
const INF = 1e30;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function degToRad(degrees) {
  return degrees * DEG;
}

export function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeSettings(settings = {}) {
  const modelType = MODEL_TYPES.includes(settings.modelType)
    ? settings.modelType
    : DEFAULT_SETTINGS.modelType;
  const displayMode = DISPLAY_MODES.includes(settings.displayMode)
    ? settings.displayMode
    : DEFAULT_SETTINGS.displayMode;
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    enabled: settings.enabled !== false,
    modelType,
    displayMode,
    baseThickness: Math.max(
      0.001,
      finiteNumber(settings.baseThickness, DEFAULT_SETTINGS.baseThickness)
    ),
    penAngle: clamp(finiteNumber(settings.penAngle, DEFAULT_SETTINGS.penAngle), 0, 80),
    translationMin: clamp(
      finiteNumber(settings.translationMin, DEFAULT_SETTINGS.translationMin),
      0,
      10
    ),
    expansionHorizontal: clamp(
      finiteNumber(
        settings.expansionHorizontal,
        DEFAULT_SETTINGS.expansionHorizontal
      ),
      0.1,
      10000
    ),
    tolerance: clamp(
      finiteNumber(settings.tolerance, DEFAULT_SETTINGS.tolerance),
      0,
      50
    ),
    scaleRange: clamp(
      finiteNumber(settings.scaleRange, DEFAULT_SETTINGS.scaleRange),
      5,
      80
    ),
    opacity: clamp(
      finiteNumber(settings.opacity, DEFAULT_SETTINGS.opacity),
      0.05,
      1
    ),
    quality: QUALITY_DIMENSIONS[settings.quality]
      ? settings.quality
      : DEFAULT_SETTINGS.quality,
    palette: ["accessible", "classic"].includes(settings.palette)
      ? settings.palette
      : DEFAULT_SETTINGS.palette,
    fadeLowConfidence: settings.fadeLowConfidence !== false,
    carefulMeasurement: settings.carefulMeasurement !== false,
    perElement: settings.perElement === true,
    elementFocus: ELEMENT_FOCUS_MODES.includes(settings.elementFocus)
      ? settings.elementFocus
      : DEFAULT_SETTINGS.elementFocus,
    fadeOtherElements: settings.fadeOtherElements !== false,
    flowGuideMode: settings.flowGuideMode === "along" ? "along" : "across",
    useFlowGuides: settings.useFlowGuides !== false,
    showFlowGuides: settings.showFlowGuides !== false,
  };
}

/**
 * The local target thickness divided by the vertical-stem thickness.
 *
 * `tangentRad` is the outline tangent in glyph coordinates. This tangent is
 * also the local direction of the stroke. `baseThickness` is always the target
 * for a vertical stem, so it has factor 1 at 90°.
 *
 * Expansion is defined directly in thicknesses rather than by a pen angle: the
 * designer sets how thick a vertical stem and a horizontal crossbar should be,
 * and diagonals blend smoothly (sin²) between those two targets.
 */
export function modelThicknessFactor(settings, tangentRad) {
  const s = normalizeSettings(settings);
  if (s.modelType === "monoline") {
    return 1;
  }

  if (s.modelType === "translation") {
    const thinAngle = degToRad(s.penAngle);
    const min = s.translationMin;
    // The user-facing meaning of "pen edge thickness" is the thinnest stroke
    // as a fraction of the vertical target: 20% of a 100-unit stem is 20
    // units. The projection onto the vertical direction keeps vertical stems
    // at exactly 1.0, and makes a stroke parallel to the nib edge exactly
    // `min`.
    const verticalProjection = Math.max(
      Math.abs(Math.sin(thinAngle - Math.PI / 2)),
      0.02
    );
    const directional =
      Math.abs(Math.sin(thinAngle - tangentRad)) / verticalProjection;
    return min + (1 - min) * directional;
  }

  const verticalTarget = s.baseThickness;
  const horizontalTarget = s.expansionHorizontal;
  const verticality = Math.abs(Math.sin(tangentRad));
  const target =
    horizontalTarget +
    (verticalTarget - horizontalTarget) * verticality * verticality;
  return target / Math.max(verticalTarget, 0.02);
}

export function deviationPercent(actual, target) {
  return target > 0 ? ((actual - target) / target) * 100 : 0;
}

export function modelLabel(modelType) {
  switch (modelType) {
    case "translation":
      return "Translation (broad nib)";
    case "expansion":
      return "Expansion (pointed pen)";
    default:
      return "Monoline";
  }
}

/**
 * Compute the boundary of a binary mask. The outside of the raster is treated
 * as background, so callers should include a small margin around the glyph.
 */
export function extractBoundary(mask, width, height) {
  const boundary = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (!mask[index]) {
        continue;
      }
      if (
        x === 0 ||
        y === 0 ||
        x === width - 1 ||
        y === height - 1 ||
        !mask[index - 1] ||
        !mask[index + 1] ||
        !mask[index - width] ||
        !mask[index + width]
      ) {
        boundary[index] = 1;
      }
    }
  }
  return boundary;
}

/**
 * Exact squared Euclidean distance transform seeded by `seeds`, with nearest
 * seed labels. Returns squared distances in pixels and the nearest seed
 * (linear pixel index) for every raster cell.
 */
export function distanceTransform(seeds, width, height) {
  const n = width * height;
  const rowDistance = new Float64Array(n);
  const rowIndex = new Int32Array(n);
  rowDistance.fill(INF);
  rowIndex.fill(-1);

  // Distance to the nearest seed in the same row.
  for (let y = 0; y < height; y++) {
    let last = -1;
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (seeds[index]) {
        last = x;
      }
      if (last >= 0) {
        const dx = x - last;
        rowDistance[index] = dx * dx;
        rowIndex[index] = y * width + last;
      }
    }

    last = -1;
    for (let x = width - 1; x >= 0; x--) {
      const index = y * width + x;
      if (seeds[index]) {
        last = x;
      }
      if (last >= 0) {
        const dx = x - last;
        const distance = dx * dx;
        if (distance < rowDistance[index]) {
          rowDistance[index] = distance;
          rowIndex[index] = y * width + last;
        }
      }
    }
  }

  const distance = new Float64Array(n);
  const nearest = new Int32Array(n);
  distance.fill(INF);
  nearest.fill(-1);

  const values = new Float64Array(height);
  const labels = new Int32Array(height);
  const parabola = new Int32Array(height);
  const envelope = new Float64Array(height + 1);

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const index = y * width + x;
      values[y] = rowDistance[index];
      labels[y] = rowIndex[index];
    }

    edt1d(values, labels, parabola, envelope, height, height, x, width, distance, nearest);
  }

  return { distance, nearest };
}

function edt1d(
  values,
  labels,
  parabola,
  envelope,
  count,
  rowLength,
  column,
  rowWidth,
  outputDistance,
  outputLabel
) {
  let k = -1;
  for (let q = 0; q < count; q++) {
    if (!Number.isFinite(values[q]) || values[q] >= INF / 2) {
      continue;
    }
    if (k < 0) {
      k = 0;
      parabola[0] = q;
      envelope[0] = -Infinity;
      envelope[1] = Infinity;
      continue;
    }

    let s = ((values[q] + q * q) - (values[parabola[k]] + parabola[k] * parabola[k])) /
      (2 * q - 2 * parabola[k]);

    while (s <= envelope[k] && k > 0) {
      k--;
      s = ((values[q] + q * q) - (values[parabola[k]] + parabola[k] * parabola[k])) /
        (2 * q - 2 * parabola[k]);
    }

    k++;
    parabola[k] = q;
    envelope[k] = s;
    envelope[k + 1] = Infinity;
  }

  if (k < 0) {
    return;
  }

  let j = 0;
  for (let q = 0; q < count; q++) {
    while (j < k && envelope[j + 1] < q) {
      j++;
    }
    const v = parabola[j];
    const dy = q - v;
    outputDistance[q * rowWidth + column] = dy * dy + values[v];
    outputLabel[q * rowWidth + column] = labels[v];
  }
}

function boxBlurMask(mask, width, height, radius) {
  const n = width * height;
  const horizontal = new Float64Array(n);
  const output = new Float64Array(n);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = 0; x <= Math.min(radius, width - 1); x++) {
      sum += mask[row + x];
    }
    for (let x = 0; x < width; x++) {
      horizontal[row + x] = sum;
      if (x - radius >= 0) {
        sum -= mask[row + x - radius];
      }
      if (x + radius + 1 < width) {
        sum += mask[row + x + radius + 1];
      }
    }
  }

  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = 0; y <= Math.min(radius, height - 1); y++) {
      sum += horizontal[y * width + x];
    }
    for (let y = 0; y < height; y++) {
      output[y * width + x] = sum;
      if (y - radius >= 0) {
        sum -= horizontal[(y - radius) * width + x];
      }
      if (y + radius + 1 < height) {
        sum += horizontal[(y + radius + 1) * width + x];
      }
    }
  }

  return output;
}

/**
 * Normals from a blurred coverage field are far more stable than normals from
 * the signed distance transform, which are quantized by the raster edge and
 * produce fan-shaped measurement artifacts on curves.
 */
function inwardNormalFromCoverage(coverage, width, height, x, y, radius) {
  const xx = clamp(Math.round(x), 0, width - 1);
  const yy = clamp(Math.round(y), 0, height - 1);
  const at = (px, py) =>
    coverage[
      clamp(Math.round(py), 0, height - 1) * width +
        clamp(Math.round(px), 0, width - 1)
    ];
  const gx = (at(xx + 1, yy) - at(xx - 1, yy)) / 2;
  const gy = (at(xx, yy + 1) - at(xx, yy - 1)) / 2;
  const length = Math.hypot(gx, gy);
  if (length < 1e-9) {
    return null;
  }
  return {
    x: gx / length,
    y: gy / length,
    strength: clamp(length * (2 * radius + 1), 0, 1),
  };
}

function sampleMaskBilinear(mask, width, height, x, y) {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) {
    return 0;
  }
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const v00 = mask[y0 * width + x0];
  const v10 = mask[y0 * width + x1];
  const v01 = mask[y1 * width + x0];
  const v11 = mask[y1 * width + x1];
  return (
    v00 * (1 - fx) * (1 - fy) +
    v10 * fx * (1 - fy) +
    v01 * (1 - fx) * fy +
    v11 * fx * fy
  );
}

function traceCaliper(mask, width, height, x, y, normal, distance) {
  const step = 0.5;
  const maxDistance = Math.hypot(width, height) + 2;
  let lastInside = 0;
  let maxRadius = 0;
  let hitEdge = false;

  for (let t = step; t <= maxDistance; t += step) {
    const px = x + normal.x * t;
    const py = y + normal.y * t;
    if (px < 0 || py < 0 || px > width - 1 || py > height - 1) {
      hitEdge = true;
      break;
    }
    if (sampleMaskBilinear(mask, width, height, px, py) <= 0.5) {
      break;
    }
    lastInside = t;
    const index =
      clamp(Math.round(py), 0, height - 1) * width +
      clamp(Math.round(px), 0, width - 1);
    if (distance && mask[index]) {
      maxRadius = Math.max(maxRadius, Math.sqrt(distance[index]));
    }
  }

  return {
    widthPx: lastInside + 1,
    exitX: x + normal.x * (lastInside + 0.5),
    exitY: y + normal.y * (lastInside + 0.5),
    maxRadius,
    hitEdge,
  };
}

/**
 * Trace the same stroke from the opposite boundary. A true caliper crosses the
 * stroke and returns to its starting point; a chord that cuts across a curve or
 * a junction does not. The two widths are averaged to get the "middle ground"
 * between the two sides of the stroke.
 */
function traceBothSides(
  mask,
  width,
  height,
  coverage,
  blurRadius,
  x,
  y,
  normal,
  forward,
  distance
) {
  if (forward.hitEdge || forward.widthPx <= 1) {
    return null;
  }

  const exitNormal = inwardNormalFromCoverage(
    coverage,
    width,
    height,
    forward.exitX,
    forward.exitY,
    blurRadius
  );
  if (!exitNormal) {
    return null;
  }

  // Step half a pixel back inside along the forward direction so both traces
  // start from comparable pixel centers; starting exactly on the boundary
  // would bias the reverse width by half a pixel.
  const reverse = traceCaliper(
    mask,
    width,
    height,
    forward.exitX - normal.x * 0.5,
    forward.exitY - normal.y * 0.5,
    exitNormal,
    distance
  );
  if (reverse.hitEdge || reverse.widthPx <= 1) {
    return null;
  }

  const maxWidth = Math.max(forward.widthPx, reverse.widthPx);
  const widthAgreement =
    maxWidth > 0
      ? 1 - Math.abs(forward.widthPx - reverse.widthPx) / maxWidth
      : 0;
  const endpointDistance = Math.hypot(reverse.exitX - x, reverse.exitY - y);
  const endpointTolerance = Math.max(3, 0.3 * maxWidth);
  const endpointAgreement = clamp(
    1 - Math.max(0, endpointDistance - 2) / endpointTolerance,
    0,
    1
  );
  const directionAgreement = clamp(
    -(normal.x * exitNormal.x + normal.y * exitNormal.y),
    0,
    1
  );

  return {
    exitNormal,
    reverse,
    widthPx: (forward.widthPx + reverse.widthPx) / 2,
    agreement:
      widthAgreement *
      endpointAgreement *
      (0.7 + 0.3 * directionAgreement),
    widthAgreement,
    endpointDistance,
  };
}

function medianFilter(values, mask, width, height, radius) {
  const n = width * height;
  const out = new Float32Array(n);
  const window = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (!mask[index]) {
        continue;
      }
      window.length = 0;
      for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy++) {
        for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx++) {
          const neighbor = yy * width + xx;
          if (mask[neighbor] && values[neighbor] > 0) {
            window.push(values[neighbor]);
          }
        }
      }
      out[index] = window.length ? median(window) : values[index];
    }
  }
  return out;
}

function boxBlurWeighted(values, weights, width, height, radius) {
  if (radius <= 0) {
    return { values, weights };
  }

  const n = width * height;
  const horizontalValues = new Float64Array(n);
  const horizontalWeights = new Float64Array(n);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sumValue = 0;
    let sumWeight = 0;
    for (let x = 0; x <= Math.min(radius, width - 1); x++) {
      sumValue += values[row + x];
      sumWeight += weights[row + x];
    }
    for (let x = 0; x < width; x++) {
      horizontalValues[row + x] = sumValue;
      horizontalWeights[row + x] = sumWeight;
      if (x - radius >= 0) {
        sumValue -= values[row + x - radius];
        sumWeight -= weights[row + x - radius];
      }
      if (x + radius + 1 < width) {
        sumValue += values[row + x + radius + 1];
        sumWeight += weights[row + x + radius + 1];
      }
    }
  }

  const blurredValues = new Float64Array(n);
  const blurredWeights = new Float64Array(n);

  for (let x = 0; x < width; x++) {
    let sumValue = 0;
    let sumWeight = 0;
    for (let y = 0; y <= Math.min(radius, height - 1); y++) {
      const index = y * width + x;
      sumValue += horizontalValues[index];
      sumWeight += horizontalWeights[index];
    }
    for (let y = 0; y < height; y++) {
      const index = y * width + x;
      blurredValues[index] = sumValue;
      blurredWeights[index] = sumWeight;
      if (y - radius >= 0) {
        const removeIndex = (y - radius) * width + x;
        sumValue -= horizontalValues[removeIndex];
        sumWeight -= horizontalWeights[removeIndex];
      }
      if (y + radius + 1 < height) {
        const addIndex = (y + radius + 1) * width + x;
        sumValue += horizontalValues[addIndex];
        sumWeight += horizontalWeights[addIndex];
      }
    }
  }

  return { values: blurredValues, weights: blurredWeights };
}

/**
 * A confident boundary sample may only supply a width to pixels that lie in
 * front of it, roughly along its inward normal. Without this check, the nearest
 * confident sample can sit across a junction or a concave corner, and its
 * Voronoi wedge paints one stroke's color into the neighbouring stroke.
 */
export function sampleSupportsPixel(
  samples,
  seedIndex,
  x,
  y,
  referenceTangent
) {
  const vx = x - samples.x[seedIndex];
  const vy = y - samples.y[seedIndex];
  const along = vx * samples.nx[seedIndex] + vy * samples.ny[seedIndex];
  if (along < -0.5) {
    return false;
  }
  // A sample can only describe pixels within its own stroke. On a curve the
  // inward normal is not a narrow ray, so allow a wide wedge, but never let a
  // thin stroke's sample reach across a thick neighbouring stroke.
  const distance = Math.hypot(vx, vy);
  const measuredWidth = samples.actual?.[seedIndex];
  if (
    Number.isFinite(measuredWidth) &&
    measuredWidth > 0 &&
    distance > measuredWidth * 1.15 + 2
  ) {
    return false;
  }
  const lateral = Math.abs(
    vx * samples.ny[seedIndex] - vy * samples.nx[seedIndex]
  );
  if (lateral > along * 3.5 + 2) {
    return false;
  }
  if (referenceTangent != null) {
    // Tangents are stored as directions; cos(2 * delta) treats opposite
    // directions as the same stroke and rejects a seed from another stroke.
    const agreement = Math.cos(
      2 * (samples.tangent[seedIndex] - referenceTangent)
    );
    if (agreement < 0.25) {
      return false;
    }
  }
  return true;
}

/**
 * Smooth widths and stroke directions while keeping different strokes apart.
 * A plain box blur averages the thin arm's direction into a neighbouring bowl
 * and produces radial fans at a junction. This filter only accepts a neighbour
 * when its doubled-angle direction agrees with the pixel's own raw boundary
 * sample, so directions diffuse along a stroke but not across it.
 */
function smoothCompatibleField(
  actual,
  directionX,
  directionY,
  weights,
  referenceX,
  referenceY,
  mask,
  width,
  height,
  passes
) {
  const n = width * height;
  let currentActual = Float64Array.from(actual);
  let currentX = Float64Array.from(directionX);
  let currentY = Float64Array.from(directionY);
  let currentWeights = Float64Array.from(weights);
  let nextActual = new Float64Array(n);
  let nextX = new Float64Array(n);
  let nextY = new Float64Array(n);
  let nextWeights = new Float64Array(n);
  const offsets = [
    [-1, -1, 0.5],
    [0, -1, 1],
    [1, -1, 0.5],
    [-1, 0, 1],
    [0, 0, 1],
    [1, 0, 1],
    [-1, 1, 0.5],
    [0, 1, 1],
    [1, 1, 0.5],
  ];

  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        if (!mask[index]) {
          continue;
        }
        const rx = referenceX[index];
        const ry = referenceY[index];
        const hasReference = rx * rx + ry * ry > 1e-6;
        let sumWeight = 0;
        let sumActual = 0;
        let sumX = 0;
        let sumY = 0;
        for (const [dx, dy, spatial] of offsets) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= width || yy >= height) {
            continue;
          }
          const neighbor = yy * width + xx;
          if (!mask[neighbor]) {
            continue;
          }
          const neighborWeight = currentWeights[neighbor];
          if (neighborWeight <= 1e-6) {
            continue;
          }
          let compatibility = 1;
          if (hasReference) {
            const length = Math.hypot(
              currentX[neighbor],
              currentY[neighbor]
            );
            if (length > 1e-6) {
              const dot =
                (rx * currentX[neighbor] + ry * currentY[neighbor]) / length;
              // cos(2 * angle difference): parallel and opposite strokes agree;
              // perpendicular and diagonal strokes are rejected.
              compatibility = Math.max(0, dot);
              compatibility *= compatibility;
              compatibility *= compatibility;
            } else {
              compatibility = 0;
            }
          }
          if (compatibility <= 0) {
            continue;
          }
          const weight = neighborWeight * spatial * compatibility;
          sumWeight += weight;
          sumActual += currentActual[neighbor] * weight;
          sumX += currentX[neighbor] * weight;
          sumY += currentY[neighbor] * weight;
        }
        if (sumWeight > 1e-6) {
          nextActual[index] = sumActual / sumWeight;
          const length = Math.hypot(sumX, sumY);
          if (length > 1e-6) {
            nextX[index] = sumX / length;
            nextY[index] = sumY / length;
          }
          nextWeights[index] = Math.min(1, sumWeight / 6);
        } else {
          nextActual[index] = currentActual[index];
          nextX[index] = currentX[index];
          nextY[index] = currentY[index];
          nextWeights[index] = currentWeights[index];
        }
      }
    }
    [currentActual, nextActual] = [nextActual, currentActual];
    [currentX, nextX] = [nextX, currentX];
    [currentY, nextY] = [nextY, currentY];
    [currentWeights, nextWeights] = [nextWeights, currentWeights];
    nextActual.fill(0);
    nextX.fill(0);
    nextY.fill(0);
    nextWeights.fill(0);
  }

  return {
    actual: currentActual,
    directionX: currentX,
    directionY: currentY,
    weights: currentWeights,
  };
}

const GUIDE_SAMPLE_STEP = 0.75;
const GUIDE_MAX_SAMPLES_PER_GUIDE = 20000;

function traceGuideWidthPx(mask, width, height, x, y, tx, ty) {
  const step = 0.5;
  const maxDistance = Math.hypot(width, height) + 2;
  let backward = 0;
  let forward = 0;

  for (let distance = step; distance <= maxDistance; distance += step) {
    const px = x - tx * distance;
    const py = y - ty * distance;
    if (
      px < 0 ||
      py < 0 ||
      px > width - 1 ||
      py > height - 1 ||
      sampleMaskBilinear(mask, width, height, px, py) <= 0.5
    ) {
      break;
    }
    backward = distance;
  }

  for (let distance = step; distance <= maxDistance; distance += step) {
    const px = x + tx * distance;
    const py = y + ty * distance;
    if (
      px < 0 ||
      py < 0 ||
      px > width - 1 ||
      py > height - 1 ||
      sampleMaskBilinear(mask, width, height, px, py) <= 0.5
    ) {
      break;
    }
    forward = distance;
  }

  return backward + forward + 1;
}

function densifyGuide(points) {
  const dense = [];
  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1];
    const end = points[i];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const steps = Math.max(1, Math.ceil(length / GUIDE_SAMPLE_STEP));
    for (let step = 0; step < steps; step++) {
      const t = step / steps;
      dense.push({
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
      });
      if (dense.length >= GUIDE_MAX_SAMPLES_PER_GUIDE) {
        return dense;
      }
    }
  }
  if (points.length) {
    dense.push(points[points.length - 1]);
  }
  return dense;
}

/**
 * Turn user-drawn guide polylines into a local direction field. In `across`
 * mode a guide is a cross-section: its perpendicular is the stroke flow and
 * its ink span is a manual caliper width. In `along` mode the guide itself is
 * the flow direction.
 *
 * Only guide samples inside the ink become seeds. Each ink pixel takes the
 * nearest seed, with a smooth falloff so an isolated guide cannot repaint the
 * whole glyph.
 */
export function buildFlowGuideField(mask, width, height, guides, options = {}) {
  if (!Array.isArray(guides) || !guides.length) {
    return null;
  }

  const mode = options.mode === "along" ? "along" : "across";
  const scale = Math.max(options.scale ?? 1, 1e-6);
  const n = width * height;
  const seed = new Uint8Array(n);
  const seedCos = new Float32Array(n);
  const seedSin = new Float32Array(n);
  const seedActual = new Float32Array(n);
  const widthSamples = [];
  let seedCount = 0;

  for (const points of guides) {
    if (!Array.isArray(points) || points.length < 2) {
      continue;
    }
    const dense = densifyGuide(points);
    if (dense.length < 2) {
      continue;
    }

    for (let i = 0; i < dense.length; i++) {
      const previous = dense[Math.max(0, i - 1)];
      const next = dense[Math.min(dense.length - 1, i + 1)];
      let tx = next.x - previous.x;
      let ty = next.y - previous.y;
      const tangentLength = Math.hypot(tx, ty);
      if (tangentLength <= 1e-6) {
        continue;
      }
      tx /= tangentLength;
      ty /= tangentLength;

      const x = dense[i].x;
      const y = dense[i].y;
      const px = Math.round(x);
      const py = Math.round(y);
      if (px < 0 || py < 0 || px >= width || py >= height) {
        continue;
      }
      const index = py * width + px;
      if (!mask[index]) {
        continue;
      }

      let widthPx = 0;
      if (mode === "across") {
        widthPx = traceGuideWidthPx(mask, width, height, x, y, tx, ty);
        if (!(widthPx > 0)) {
          continue;
        }
        widthSamples.push(widthPx);
      }

      // `across`: the line is the caliper, so flow is perpendicular to it.
      // `along`: the line itself runs down the stroke.
      const flowTangent =
        mode === "across" ? Math.atan2(tx, -ty) : Math.atan2(ty, tx);
      const doubled = 2 * flowTangent;
      seed[index] = 1;
      seedCos[index] = Math.cos(doubled);
      seedSin[index] = Math.sin(doubled);
      seedActual[index] = widthPx / scale;
      seedCount++;
    }
  }

  if (!seedCount) {
    return null;
  }

  const { distance, nearest } = distanceTransform(seed, width, height);
  const medianWidthPx = widthSamples.length ? median(widthSamples) : 0;
  const fallbackReach = options.fallbackReachPx ?? 0;
  let reachPx =
    mode === "across" && medianWidthPx > 0
      ? medianWidthPx * 2.2 + 8
      : fallbackReach;
  if (!(reachPx > 0)) {
    reachPx = Math.max(12, Math.min(width, height) * 0.25);
  }
  reachPx = clamp(reachPx, 10, Math.max(width, height) * 0.65);

  const weight = new Float32Array(n);
  const directionX = new Float32Array(n);
  const directionY = new Float32Array(n);
  const actual = new Float32Array(n);
  let influencedPixels = 0;

  for (let index = 0; index < n; index++) {
    if (!mask[index]) {
      continue;
    }
    const seedIndex = nearest[index];
    if (seedIndex < 0) {
      continue;
    }
    const distancePx = Math.sqrt(distance[index]);
    if (!(distancePx < reachPx)) {
      continue;
    }
    const t = 1 - distancePx / reachPx;
    // Smoothstep keeps the guide fully in control on the line and hands the
    // measurement back to the outline gradually.
    const guideWeight = t * t * (3 - 2 * t);
    directionX[index] = seedCos[seedIndex];
    directionY[index] = seedSin[seedIndex];
    actual[index] = seedActual[seedIndex];
    weight[index] = guideWeight;
    influencedPixels++;
  }

  if (!influencedPixels) {
    return null;
  }

  return {
    mode,
    width,
    height,
    weight,
    directionX,
    directionY,
    actual,
    guideCount: guides.length,
    reachPx,
    influencedPixels,
  };
}

function blendTangents(baseTangent, guideX, guideY, weight) {
  if (!(weight > 0)) {
    return baseTangent;
  }
  const baseX = Math.cos(2 * baseTangent);
  const baseY = Math.sin(2 * baseTangent);
  const x = baseX * (1 - weight) + guideX * weight;
  const y = baseY * (1 - weight) + guideY * weight;
  if (Math.hypot(x, y) <= 1e-6) {
    return baseTangent;
  }
  return 0.5 * Math.atan2(y, x);
}

function applyFlowGuidesToSamples(samples, field, settings) {
  if (!field) {
    return;
  }
  const width = field.width;
  const height = field.height;
  for (let i = 0; i < samples.pointCount; i++) {
    const px = clamp(Math.round(samples.x[i]), 0, width - 1);
    const py = clamp(Math.round(samples.y[i]), 0, height - 1);
    const index = py * width + px;
    const weight = field.weight[index];
    if (!(weight > 0)) {
      continue;
    }

    samples.tangent[i] = blendTangents(
      samples.tangent[i],
      field.directionX[index],
      field.directionY[index],
      weight
    );
    if (field.actual[index] > 0) {
      samples.actual[i] =
        samples.actual[i] * (1 - weight) + field.actual[index] * weight;
    }
    samples.confidence[i] =
      samples.confidence[i] * (1 - weight) + 0.95 * weight;
    samples.target[i] =
      settings.baseThickness *
      modelThicknessFactor(settings, samples.tangent[i]);
    samples.deviation[i] = deviationPercent(
      samples.actual[i],
      samples.target[i]
    );
  }
}

function buildPixelMaps(analysis, mask, settings, flowGuides = null) {
  const { width, height, samples } = analysis;
  const n = width * height;
  const actual = new Float32Array(n);
  const target = new Float32Array(n);
  const confidence = new Float32Array(n);
  // Raw nearest-sample values, used by absolute display modes when an ink pixel
  // has no confident sample at all. Deviation modes keep using the confident
  // field and its confidence fade.
  const fallbackActual = new Float32Array(n);
  const fallbackTarget = new Float32Array(n);
  const actualWeighted = new Float64Array(n);
  const directionXWeighted = new Float64Array(n);
  const directionYWeighted = new Float64Array(n);
  const weights = new Float64Array(n);
  const referenceX = new Float64Array(n);
  const referenceY = new Float64Array(n);
  const confidenceWeighted = new Float64Array(n);
  const confidenceWeights = new Float64Array(n);

  for (let index = 0; index < n; index++) {
    if (!mask[index]) {
      continue;
    }

    const rawIndex = analysis.nearestSample[index];
    if (rawIndex >= 0) {
      fallbackActual[index] = samples.actual[rawIndex];
      fallbackTarget[index] = samples.target[rawIndex];
      const doubledReference = 2 * samples.tangent[rawIndex];
      referenceX[index] = Math.cos(doubledReference);
      referenceY[index] = Math.sin(doubledReference);
    }

    // Widths come only from confidently measured boundary samples. Ambiguous
    // samples at junctions and terminals own large Voronoi wedges; letting them
    // supply values produced radial fans of wrong color.
    const confidentIndex = analysis.nearestConfidentSample[index];
    let valueIndex =
      confidentIndex >= 0
        ? confidentIndex
        : settings.carefulMeasurement
          ? -1
          : rawIndex;
    if (valueIndex < 0) {
      continue;
    }

    // Reject a confident seed that is across a junction from this pixel. Fall
    // back to the local sample when it is trusted enough (fast mode); otherwise
    // leave the pixel to the confidence fade instead of pulling in a distant
    // stroke's width or direction.
    const rawConfidence = rawIndex >= 0 ? samples.confidence[rawIndex] : 0;
    if (
      valueIndex !== rawIndex &&
      rawIndex >= 0 &&
      !sampleSupportsPixel(
        samples,
        valueIndex,
        index % analysis.width,
        Math.floor(index / analysis.width),
        // A stroke-end sample can be confidently rejected by careful mode but
        // still have a perpendicular tangent. Only trust the local tangent when
        // the raw sample itself is plausible.
        rawConfidence >= 0.25 ? samples.tangent[rawIndex] : null
      )
    ) {
      // A confident local sample is a better answer than a hole. Only fall
      // back to it when it is trusted; otherwise let the fade handle the pixel.
      valueIndex =
        !settings.carefulMeasurement || rawConfidence >= CONFIDENCE_PROPAGATE
          ? rawIndex
          : -1;
      if (valueIndex < 0) {
        continue;
      }
    }

    // The fade field still follows the plain nearest sample, so genuinely
    // uncertain regions fade no matter how far the nearest confident sample
    // is.
    const fadeSampleIndex = rawIndex >= 0 ? rawIndex : valueIndex;
    const sampleConfidence = samples.confidence[fadeSampleIndex];

    // In careful mode, ambiguous junction samples must not pull the smoothed
    // direction field or the width field toward their chord measurement.
    const valueConfidence = samples.confidence[valueIndex];
    const weight = settings.carefulMeasurement
      ? valueConfidence >= CONFIDENCE_PROPAGATE
        ? valueConfidence * valueConfidence
        : 0
      : 0.05 + sampleConfidence * sampleConfidence;
    actual[index] = samples.actual[valueIndex];
    actualWeighted[index] = samples.actual[valueIndex] * weight;

    // Store direction as a doubled angle. A tangent and its opposite describe
    // the same stroke direction, and doubling maps them to the same vector, so
    // smoothing across the medial axis cannot cancel the direction.
    const doubled = 2 * samples.tangent[valueIndex];
    directionXWeighted[index] = Math.cos(doubled) * weight;
    directionYWeighted[index] = Math.sin(doubled) * weight;
    weights[index] = weight;

    confidenceWeighted[index] = sampleConfidence;
    confidenceWeights[index] = 1;
  }

  const radius = clamp(
    Math.round((settings.baseThickness * analysis.scale) / 8),
    4,
    20
  );
  // A plain blur mixes the diagonal arm's tangent into the bowl and creates
  // target fans around junctions. Diffuse only between neighbours whose
  // doubled-angle directions agree with the pixel's own boundary sample.
  const smoothed = smoothCompatibleField(
    actualWeighted,
    directionXWeighted,
    directionYWeighted,
    weights,
    referenceX,
    referenceY,
    mask,
    width,
    height,
    6
  );
  const confidenceRadius = clamp(Math.round(radius * 0.75), 3, 14);
  const blurredConfidence = boxBlurWeighted(
    confidenceWeighted,
    confidenceWeights,
    width,
    height,
    confidenceRadius
  );

  for (let index = 0; index < n; index++) {
    if (!mask[index]) {
      continue;
    }
    if (smoothed.actual[index] > 0) {
      actual[index] = smoothed.actual[index];
    }
    const dx = smoothed.directionX[index];
    const dy = smoothed.directionY[index];
    let tangent = null;
    if (Math.hypot(dx, dy) > 1e-3) {
      tangent = 0.5 * Math.atan2(dy, dx);
    }

    const totalConfidenceWeight = blurredConfidence.weights[index];
    confidence[index] =
      totalConfidenceWeight > 1e-4
        ? blurredConfidence.values[index] / totalConfidenceWeight
        : 0;

    const guideWeight = flowGuides ? flowGuides.weight[index] : 0;
    if (guideWeight > 0) {
      if (tangent == null) {
        tangent =
          0.5 *
          Math.atan2(
            flowGuides.directionY[index],
            flowGuides.directionX[index]
          );
      } else {
        tangent = blendTangents(
          tangent,
          flowGuides.directionX[index],
          flowGuides.directionY[index],
          guideWeight
        );
      }
      if (flowGuides.actual[index] > 0) {
        actual[index] =
          actual[index] * (1 - guideWeight) +
          flowGuides.actual[index] * guideWeight;
      }
      // A guide is an explicit instruction, so its area should not disappear
      // behind the confidence fade.
      confidence[index] =
        confidence[index] * (1 - guideWeight) + 0.95 * guideWeight;
    }

    if (tangent != null) {
      target[index] =
        settings.baseThickness * modelThicknessFactor(settings, tangent);
    }
  }

  return {
    actual,
    target,
    confidence,
    fallbackActual,
    fallbackTarget,
    debug: {
      actualWeighted,
      weights,
      smoothed,
      directionXWeighted,
      directionYWeighted,
    },
  };
}

function median(values) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return quantileSorted(sorted, 0.5);
}

function quantileSorted(sorted, q) {
  if (!sorted.length) {
    return 0;
  }
  if (sorted.length === 1) {
    return sorted[0];
  }
  const position = clamp(q, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

export function summarizeSamples(samples, tolerance) {
  const accepted = [];
  for (let i = 0; i < samples.confidence.length; i++) {
    if (samples.confidence[i] >= CONFIDENCE_ACCEPT && samples.actual[i] > 0) {
      accepted.push(i);
    }
  }
  if (!accepted.length) {
    return {
      count: 0,
      actualMedian: 0,
      targetMedian: 0,
      deviationMedian: 0,
      deviationP10: 0,
      deviationP90: 0,
      absDeviationMedian: 0,
      withinPercent: 0,
      thickPercent: 0,
      thinPercent: 0,
      actualMin: 0,
      actualMax: 0,
      targetMin: 0,
      targetMax: 0,
    };
  }

  const actual = accepted.map((i) => samples.actual[i]).sort((a, b) => a - b);
  const target = accepted.map((i) => samples.target[i]).sort((a, b) => a - b);
  const deviation = accepted
    .map((i) => samples.deviation[i])
    .sort((a, b) => a - b);
  const absoluteDeviation = deviation
    .map((value) => Math.abs(value))
    .sort((a, b) => a - b);

  let within = 0;
  let thick = 0;
  let thin = 0;
  for (const value of deviation) {
    if (Math.abs(value) <= tolerance) {
      within++;
    } else if (value > 0) {
      thick++;
    } else {
      thin++;
    }
  }

  return {
    count: accepted.length,
    actualMedian: quantileSorted(actual, 0.5),
    targetMedian: quantileSorted(target, 0.5),
    deviationMedian: quantileSorted(deviation, 0.5),
    deviationP10: quantileSorted(deviation, 0.1),
    deviationP90: quantileSorted(deviation, 0.9),
    absDeviationMedian: quantileSorted(absoluteDeviation, 0.5),
    withinPercent: (100 * within) / accepted.length,
    thickPercent: (100 * thick) / accepted.length,
    thinPercent: (100 * thin) / accepted.length,
    actualMin: actual[0],
    actualMax: actual[actual.length - 1],
    targetMin: target[0],
    targetMax: target[target.length - 1],
  };
}

function createSampleStore(capacity) {
  return {
    pixel: new Int32Array(capacity),
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    nx: new Float32Array(capacity),
    ny: new Float32Array(capacity),
    tangent: new Float32Array(capacity),
    actual: new Float32Array(capacity),
    target: new Float32Array(capacity),
    deviation: new Float32Array(capacity),
    confidence: new Float32Array(capacity),
    pointCount: 0,
  };
}

function pushSample(store, sample) {
  const index = store.pointCount++;
  store.pixel[index] = sample.pixel;
  store.x[index] = sample.x;
  store.y[index] = sample.y;
  store.nx[index] = sample.nx;
  store.ny[index] = sample.ny;
  store.tangent[index] = sample.tangent;
  store.actual[index] = sample.actual;
  store.target[index] = sample.target;
  store.deviation[index] = sample.deviation;
  store.confidence[index] = sample.confidence;
}

/**
 * Boundary normals and caliper widths wobble by a pixel or two because the
 * raster edge is discrete. Smooth them along the boundary (only with samples
 * that point in a similar direction) before they are assigned to the inside
 * of the stroke. Without this, the nearest-boundary propagation produces
 * wedge-shaped color artifacts on curves.
 */
function smoothBoundarySamples(
  samples,
  boundaryToSample,
  width,
  height,
  settings,
  radiusOverride
) {
  const smoothed = createSampleStore(samples.pointCount);
  const careful = settings.carefulMeasurement;
  const radius =
    radiusOverride ?? clamp(Math.round(Math.min(width, height) / 120), 3, 8);
  // A wider window is needed to notice that the two sides of a junction meet
  // at a sharp angle. The smoothing radius itself stays small so ordinary
  // curves are not flattened.
  const cornerRadius = careful
    ? clamp(Math.round(radius * 1.75), 6, 14)
    : radius;
  const scanRadius = Math.max(radius, cornerRadius);
  const scanRadiusSquared = scanRadius * scanRadius;

  for (let i = 0; i < samples.pointCount; i++) {
    const x = samples.x[i];
    const y = samples.y[i];
    const nx = samples.nx[i];
    const ny = samples.ny[i];
    const xi = Math.round(x);
    const yi = Math.round(y);

    let sumNx = 0;
    let sumNy = 0;
    let sumConfidence = 0;
    let sumWeight = 0;
    let minDot = 1;
    const widths = [];

    for (let yy = yi - scanRadius; yy <= yi + scanRadius; yy++) {
      if (yy < 0 || yy >= height) {
        continue;
      }
      for (let xx = xi - scanRadius; xx <= xi + scanRadius; xx++) {
        if (xx < 0 || xx >= width) {
          continue;
        }
        const dx = xx - xi;
        const dy = yy - yi;
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared > scanRadiusSquared) {
          continue;
        }
        const neighborIndex = boundaryToSample[yy * width + xx];
        if (neighborIndex < 0) {
          continue;
        }
        const neighborConfidence = samples.confidence[neighborIndex];
        const dot = nx * samples.nx[neighborIndex] + ny * samples.ny[neighborIndex];
        minDot = Math.min(minDot, dot);
        if (distanceSquared > radius * radius || dot < 0.55) {
          continue;
        }
        if (careful && neighborConfidence < 0.2) {
          continue;
        }
        if (!careful || neighborConfidence >= CONFIDENCE_ACCEPT) {
          widths.push(samples.actual[neighborIndex]);
        }
        const spatialWeight =
          1 - (Math.sqrt(distanceSquared) / radius) * 0.55;
        const weight = careful
          ? spatialWeight * Math.max(0, neighborConfidence - 0.15)
          : spatialWeight * (0.2 + neighborConfidence);
        sumNx += samples.nx[neighborIndex] * weight;
        sumNy += samples.ny[neighborIndex] * weight;
        sumConfidence += neighborConfidence * weight;
        sumWeight += weight;
      }
    }

    let newNx = nx;
    let newNy = ny;
    let actual = samples.actual[i];
    let confidence = samples.confidence[i];

    if (sumWeight > 0) {
      const length = Math.hypot(sumNx, sumNy);
      if (length > 1e-6) {
        newNx = sumNx / length;
        newNy = sumNy / length;
      }
      if (widths.length) {
        widths.sort((a, b) => a - b);
        actual = widths[Math.floor(widths.length / 2)];
      }
      confidence = Math.min(
        samples.confidence[i],
        (sumConfidence / sumWeight) * 1.15
      );
    }

    // Sharp turns are junctions, terminals, or corners. The caliper there is
    // geometrically ambiguous, so fade it instead of coloring it as an error.
    const turn = Math.acos(clamp(minDot, -1, 1));
    const cornerConsistency = clamp(1 - (turn - 0.35) / 0.8, 0, 1);
    confidence *= cornerConsistency;

    const tangent = Math.atan2(newNx, -newNy);
    const target = settings.baseThickness * modelThicknessFactor(settings, tangent);
    pushSample(smoothed, {
      pixel: samples.pixel[i],
      x,
      y,
      nx: newNx,
      ny: newNy,
      tangent,
      actual,
      target,
      deviation: deviationPercent(actual, target),
      confidence,
    });
  }

  return smoothed;
}

/**
 * Measure caliper widths at every boundary pixel and associate each ink pixel
 * with its nearest boundary measurement.
 *
 * @param {Uint8Array} mask Binary ink mask; 1 = ink.
 * @param {number} width Raster width in pixels.
 * @param {number} height Raster height in pixels.
 * @param {object} settings Heatmap settings.
 * @param {number} scale Raster pixels per font unit.
 */
export function analyzeMask(mask, width, height, settings, scale, options = {}) {
  const normalized = normalizeSettings(settings);
  const boundary = extractBoundary(mask, width, height);
  const { distance, nearest } = distanceTransform(boundary, width, height);
  const rawSamples = createSampleStore(width * height);
  const boundaryToSample = new Int32Array(width * height);
  boundaryToSample.fill(-1);

  // Per-element crops must use the same blur/smoothing radius as the whole
  // glyph, otherwise the same stroke would be smoothed differently depending
  // on how much empty space surrounds its element.
  const blurRadius =
    options.blurRadius ?? clamp(Math.round(Math.min(width, height) / 120), 3, 8);
  const coverage = boxBlurMask(mask, width, height, blurRadius);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (!boundary[index]) {
        continue;
      }

      const normal = inwardNormalFromCoverage(
        coverage,
        width,
        height,
        x,
        y,
        blurRadius
      );
      if (!normal) {
        continue;
      }

      const forward = traceCaliper(
        mask,
        width,
        height,
        x,
        y,
        normal,
        distance
      );

      let exitNormal = null;
      let actualWidthPx = forward.widthPx;
      let agreement = forward.hitEdge ? 0 : 1;
      let tangentNormalX = normal.x;
      let tangentNormalY = normal.y;

      if (normalized.carefulMeasurement) {
        const both = traceBothSides(
          mask,
          width,
          height,
          coverage,
          blurRadius,
          x,
          y,
          normal,
          forward,
          distance
        );
        if (both) {
          exitNormal = both.exitNormal;
          actualWidthPx = both.widthPx;
          agreement = both.agreement;

          // The two boundary normals point in opposite directions across a
          // perfect stroke. Their difference is a stable "middle ground"
          // normal on curved strokes, where the two sides are not exactly
          // parallel.
          const midX = normal.x - both.exitNormal.x;
          const midY = normal.y - both.exitNormal.y;
          const midLength = Math.hypot(midX, midY);
          if (midLength > 1e-6) {
            tangentNormalX = midX / midLength;
            tangentNormalY = midY / midLength;
          }
        } else {
          agreement = 0;
        }
      } else {
        exitNormal = inwardNormalFromCoverage(
          coverage,
          width,
          height,
          forward.exitX,
          forward.exitY,
          blurRadius
        );
      }

      let alignment = 0;
      if (exitNormal) {
        alignment = clamp(
          -(normal.x * exitNormal.x + normal.y * exitNormal.y),
          0,
          1
        );
      }

      // A line that truly crosses the stroke reaches the medial axis, so the
      // deepest point on it should be about half the measured width from the
      // boundary. Rays that graze along a stroke or a junction fail this test.
      const radialRatio =
        forward.widthPx > 0 ? (2 * forward.maxRadius) / forward.widthPx : 0;
      const medialConsistency = clamp((radialRatio - 0.55) / 0.35, 0, 1);

      // In a tight, thick bowl the boundary normals at the two ends of a
      // correct caliper converge; they are not exactly antiparallel, so the
      // alignment test is only a weak hint. The medial-depth test and the
      // corner test below are the stronger signals. In careful mode the
      // two-sided agreement test rejects chords that cross a curve or a
      // junction.
      const confidence = clamp(
        (0.75 + 0.25 * alignment) *
          medialConsistency *
          (0.6 + 0.4 * normal.strength) *
          agreement,
        0,
        1
      );

      // The inward normal runs across the stroke; the stroke itself runs
      // perpendicular to it.
      const tangent = Math.atan2(tangentNormalX, -tangentNormalY);
      const actual = actualWidthPx / Math.max(scale, 1e-6);
      const target = normalized.baseThickness * modelThicknessFactor(normalized, tangent);

      boundaryToSample[index] = rawSamples.pointCount;
      pushSample(rawSamples, {
        pixel: index,
        x,
        y,
        nx: normal.x,
        ny: normal.y,
        tangent,
        actual,
        target,
        deviation: deviationPercent(actual, target),
        confidence,
      });
    }
  }

  const samples = smoothBoundarySamples(
    rawSamples,
    boundaryToSample,
    width,
    height,
    normalized,
    blurRadius
  );

  let flowGuideField = null;
  if (normalized.useFlowGuides && options.guides?.length) {
    const trustedWidths = [];
    for (let i = 0; i < samples.pointCount; i++) {
      if (
        samples.confidence[i] >= CONFIDENCE_ACCEPT &&
        samples.actual[i] > 0
      ) {
        trustedWidths.push(samples.actual[i] * scale);
      }
    }
    const medianWidthPx = trustedWidths.length ? median(trustedWidths) : 0;
    flowGuideField = buildFlowGuideField(
      mask,
      width,
      height,
      options.guides,
      {
        mode: normalized.flowGuideMode,
        scale,
        fallbackReachPx: medianWidthPx > 0 ? medianWidthPx * 2.2 + 8 : 0,
      }
    );
    applyFlowGuidesToSamples(samples, flowGuideField, normalized);
  }

  boundaryToSample.fill(-1);
  for (let i = 0; i < samples.pointCount; i++) {
    boundaryToSample[samples.pixel[i]] = i;
  }

  const nearestSample = new Int32Array(width * height);
  nearestSample.fill(-1);
  for (let index = 0; index < nearestSample.length; index++) {
    if (!mask[index] || nearest[index] < 0) {
      continue;
    }
    nearestSample[index] = boundaryToSample[nearest[index]];
  }

  // Second distance transform seeded only by trusted samples. Pixel widths are
  // taken from this field so a wedge of ambiguous junction samples cannot paint
  // a fan of extreme values into the stroke interior.
  const confidentSeeds = new Uint8Array(width * height);
  for (let i = 0; i < samples.pointCount; i++) {
    if (samples.confidence[i] >= CONFIDENCE_PROPAGATE) {
      confidentSeeds[samples.pixel[i]] = 1;
    }
  }
  const { nearest: nearestConfident } = distanceTransform(
    confidentSeeds,
    width,
    height
  );
  const nearestConfidentSample = new Int32Array(width * height);
  nearestConfidentSample.fill(-1);
  for (let index = 0; index < nearestConfidentSample.length; index++) {
    if (!mask[index] || nearestConfident[index] < 0) {
      continue;
    }
    nearestConfidentSample[index] = boundaryToSample[nearestConfident[index]];
  }

  const analysis = {
    width,
    height,
    scale,
    mask,
    boundary,
    nearestSample,
    nearestConfidentSample,
    samples,
    flowGuides: flowGuideField
      ? {
          mode: flowGuideField.mode,
          guideCount: flowGuideField.guideCount,
          reachPx: flowGuideField.reachPx,
          influencedPixels: flowGuideField.influencedPixels,
        }
      : null,
    stats: summarizeSamples(samples, normalized.tolerance),
  };
  analysis.pixels = buildPixelMaps(
    analysis,
    mask,
    normalized,
    flowGuideField
  );
  return analysis;
}

/**
 * Estimate vertical (stem) and horizontal (crossbar) thicknesses from the
 * current outline. Medians keep a single terminal or junction from deciding
 * the result.
 */
export function estimateThicknessesFromAnalysis(analysis) {
  if (!analysis || !analysis.samples.pointCount) {
    return null;
  }
  const samples = analysis.samples;
  const vertical = [];
  const horizontal = [];
  const all = [];
  for (let i = 0; i < samples.pointCount; i++) {
    if (samples.confidence[i] < CONFIDENCE_ACCEPT || !(samples.actual[i] > 0)) {
      continue;
    }
    const actual = samples.actual[i];
    const sin = Math.abs(Math.sin(samples.tangent[i]));
    all.push(actual);
    if (sin >= 0.95) {
      vertical.push(actual);
    } else if (sin <= 0.2) {
      horizontal.push(actual);
    }
  }
  if (!all.length) {
    return null;
  }
  return {
    vertical: median(vertical.length >= 5 ? vertical : all),
    horizontal: horizontal.length >= 5 ? median(horizontal) : null,
    verticalSamples: vertical.length,
    horizontalSamples: horizontal.length,
  };
}

export function estimateBaseFromAnalysis(analysis) {
  return estimateThicknessesFromAnalysis(analysis)?.vertical ?? null;
}

export function analysisSignature(settings) {
  const s = normalizeSettings(settings);
  return [
    "v3",
    s.modelType,
    s.baseThickness.toFixed(4),
    s.penAngle.toFixed(3),
    s.translationMin.toFixed(4),
    s.expansionHorizontal.toFixed(4),
    s.tolerance.toFixed(3),
    s.quality,
    s.carefulMeasurement ? "careful" : "fast",
    s.perElement ? "elements" : "whole",
    s.useFlowGuides ? `guides-${s.flowGuideMode}` : "guides-off",
  ].join("|");
}

export function renderSignature(settings) {
  const s = normalizeSettings(settings);
  return [
    "v1",
    s.displayMode,
    s.palette,
    s.tolerance.toFixed(3),
    s.scaleRange.toFixed(3),
    s.opacity.toFixed(3),
    s.fadeLowConfidence ? "1" : "0",
    s.perElement ? "elements" : "whole",
    s.elementFocus,
    s.fadeOtherElements ? "fade" : "hide",
  ].join("|");
}
