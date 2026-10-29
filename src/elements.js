/*
 * Pure contour/component grouping for per-element measurement.
 *
 * Fontra stores a glyph as a path plus component instances. A component's path
 * is already transformed into the parent glyph's coordinate system and may
 * contain several contours, including counters and nested components. This
 * module groups those contours into independently filled shapes:
 *
 * - a contour is an element unless it lies inside another contour;
 * - an odd nesting depth with the opposite winding is a counter/hole;
 * - an even nesting depth starts a new element (an island inside a counter);
 * - contours that merely overlap stay separate elements.
 *
 * The grouping is deliberately conservative: when containment is ambiguous,
 * contours become separate elements rather than subtracting ink.
 */

const CONTAINMENT_EPSILON = 1e-6;
const DEFAULT_CURVE_STEPS = 10;

function segmentPoints(segment) {
  if (Array.isArray(segment.points)) {
    return segment.points;
  }
  const coordinates = segment.coordinates;
  if (!coordinates) {
    return [];
  }
  const points = [];
  for (let i = 0; i + 1 < coordinates.length; i += 2) {
    points.push({ x: coordinates[i], y: coordinates[i + 1] });
  }
  return points;
}

function lerpPoint(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function quadraticPoint(p0, p1, p2, t) {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

function cubicPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x:
      u * u * u * p0.x +
      3 * u * u * t * p1.x +
      3 * u * t * t * p2.x +
      t * t * t * p3.x,
    y:
      u * u * u * p0.y +
      3 * u * u * t * p1.y +
      3 * u * t * t * p2.y +
      t * t * t * p3.y,
  };
}

/**
 * Flatten one contour into a polyline in glyph coordinates. The result is used
 * only for topology (area, winding and containment), never for rasterization.
 */
export function flattenContour(path, contourIndex, curveSteps = DEFAULT_CURVE_STEPS) {
  const points = [];
  let started = false;
  let segments;
  try {
    segments = path.iterContourDecomposedSegments(contourIndex);
  } catch {
    return points;
  }

  for (const segment of segments) {
    const pts = segmentPoints(segment);
    if (!pts.length) {
      continue;
    }
    if (!started) {
      points.push(pts[0]);
      started = true;
    }
    if (segment.type === "quad" && pts.length >= 3) {
      const [p0, p1, p2] = pts;
      for (let step = 1; step <= curveSteps; step++) {
        points.push(quadraticPoint(p0, p1, p2, step / curveSteps));
      }
    } else if (segment.type === "cubic" && pts.length >= 4) {
      const [p0, p1, p2, p3] = pts;
      for (let step = 1; step <= curveSteps; step++) {
        points.push(cubicPoint(p0, p1, p2, p3, step / curveSteps));
      }
    } else if (pts.length >= 2) {
      points.push(pts[pts.length - 1]);
    }
  }

  // Closed contours repeat the first point at the end.
  if (points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (
      Math.abs(first.x - last.x) <= CONTAINMENT_EPSILON &&
      Math.abs(first.y - last.y) <= CONTAINMENT_EPSILON
    ) {
      points.pop();
    }
  }
  return points;
}

export function signedArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

export function polygonBounds(points) {
  if (!points.length) {
    return null;
  }
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const point of points) {
    xMin = Math.min(xMin, point.x);
    yMin = Math.min(yMin, point.y);
    xMax = Math.max(xMax, point.x);
    yMax = Math.max(yMax, point.y);
  }
  return { xMin, yMin, xMax, yMax };
}

function unionBounds(a, b) {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return {
    xMin: Math.min(a.xMin, b.xMin),
    yMin: Math.min(a.yMin, b.yMin),
    xMax: Math.max(a.xMax, b.xMax),
    yMax: Math.max(a.yMax, b.yMax),
  };
}

function boundsContain(outer, inner) {
  return (
    outer.xMin <= inner.xMin + CONTAINMENT_EPSILON &&
    outer.yMin <= inner.yMin + CONTAINMENT_EPSILON &&
    outer.xMax >= inner.xMax - CONTAINMENT_EPSILON &&
    outer.yMax >= inner.yMax - CONTAINMENT_EPSILON
  );
}

export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = a.y > point.y !== b.y > point.y;
    if (
      crosses &&
      point.x <
        ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 1e-30) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function polygonInside(inner, outer) {
  if (inner.length < 3 || outer.length < 3) {
    return false;
  }
  // Contours can have hundreds of flattened points. A handful of evenly
  // spaced vertices plus edge midpoints is enough to distinguish a counter
  // (fully inside) from an overlapping shape, and keeps the pairwise
  // containment pass cheap on complex glyphs.
  const samples = Math.min(inner.length, 16);
  for (let sample = 0; sample < samples; sample++) {
    const i = Math.floor((sample * inner.length) / samples);
    const point = inner[i];
    const next = inner[(i + 1) % inner.length];
    if (!pointInPolygon(point, outer)) {
      return false;
    }
    if (!pointInPolygon(lerpPoint(point, next, 0.5), outer)) {
      return false;
    }
  }
  return true;
}

function describeContours(sources) {
  const descriptors = [];
  let flattenedOffset = 0;

  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    const source = sources[sourceIndex];
    const path = source?.path;
    if (!path || !path.numContours) {
      continue;
    }
    for (let contourIndex = 0; contourIndex < path.numContours; contourIndex++) {
      const polygon = flattenContour(path, contourIndex);
      const bounds = polygonBounds(polygon);
      const area = polygon.length >= 3 ? signedArea(polygon) : 0;
      descriptors.push({
        path,
        contourIndex,
        sourceIndex,
        componentIndex: source.componentIndex ?? null,
        polygon,
        bounds,
        area,
        absArea: Math.abs(area),
        sign: area >= 0 ? 1 : -1,
        isClosed: path.contourInfo?.[contourIndex]?.isClosed !== false,
        flattenedIndex: flattenedOffset + contourIndex,
      });
    }
    flattenedOffset += path.numContours;
  }

  return { descriptors, flattenedCount: flattenedOffset };
}

/**
 * Group contours from one or more paths into independent elements.
 *
 * `sources` must list the glyph's own path first (componentIndex: null), then
 * each component instance in Fontra's component order. That matches the order
 * of `glyph.flattenedPath`.
 */
export function groupContourSources(sources) {
  const { descriptors, flattenedCount } = describeContours(sources);
  const count = descriptors.length;
  const depth = new Array(count).fill(-1);
  const root = new Array(count).fill(-1);
  const isHole = new Array(count).fill(false);

  // Find the smallest larger contour that fully contains each contour. A
  // contour that overlaps another one is not inside it, so it stays separate.
  for (let i = 0; i < count; i++) {
    const descriptor = descriptors[i];
    descriptor.parent = -1;
    if (!descriptor.bounds || descriptor.absArea <= CONTAINMENT_EPSILON) {
      continue;
    }
    let parent = -1;
    for (let j = 0; j < count; j++) {
      if (i === j) {
        continue;
      }
      const candidate = descriptors[j];
      if (
        !candidate.bounds ||
        candidate.absArea <= descriptor.absArea * (1 + CONTAINMENT_EPSILON)
      ) {
        continue;
      }
      if (!boundsContain(candidate.bounds, descriptor.bounds)) {
        continue;
      }
      if (!polygonInside(descriptor.polygon, candidate.polygon)) {
        continue;
      }
      if (parent < 0 || candidate.absArea < descriptors[parent].absArea) {
        parent = j;
      }
    }
    descriptor.parent = parent;
  }

  function resolveDepth(index) {
    if (depth[index] >= 0) {
      return;
    }
    const parent = descriptors[index].parent;
    if (parent < 0) {
      depth[index] = 0;
      root[index] = index;
      return;
    }
    resolveDepth(parent);
    depth[index] = depth[parent] + 1;
    if (depth[index] % 2 === 0) {
      // An island inside a counter is a new element.
      root[index] = index;
    } else {
      // A counter, or a redundant same-winding inner contour, belongs to the
      // element that contains it.
      root[index] = root[parent];
    }
  }

  for (let i = 0; i < count; i++) {
    resolveDepth(i);
  }

  for (let i = 0; i < count; i++) {
    const descriptor = descriptors[i];
    const parent = descriptor.parent;
    isHole[i] =
      parent >= 0 &&
      depth[i] % 2 === 1 &&
      descriptor.sign !== descriptors[parent].sign &&
      descriptor.isClosed &&
      descriptor.polygon.length >= 3;
  }

  const elements = [];
  const elementByRoot = new Map();
  for (let i = 0; i < count; i++) {
    if (root[i] !== i || !descriptors[i].bounds) {
      continue;
    }
    const descriptor = descriptors[i];
    const element = {
      index: elements.length,
      rootIndex: i,
      rootContourIndex: descriptor.contourIndex,
      componentIndex: descriptor.componentIndex,
      sourceIndex: descriptor.sourceIndex,
      solidContours: [],
      holeContours: [],
      bounds: null,
      label: "",
    };
    elements.push(element);
    elementByRoot.set(i, element);
  }

  const contourToElement = [];
  const componentToElements = [];
  const flattenedContourToElement = new Array(flattenedCount).fill(-1);
  const ownSourceIndex = sources.findIndex(
    (source) => source?.componentIndex == null
  );

  for (let i = 0; i < count; i++) {
    const descriptor = descriptors[i];
    const element = elementByRoot.get(root[i]);
    if (!element) {
      continue;
    }
    if (isHole[i]) {
      element.holeContours.push(descriptor);
    } else {
      element.solidContours.push(descriptor);
      element.bounds = unionBounds(element.bounds, descriptor.bounds);
    }
    flattenedContourToElement[descriptor.flattenedIndex] = element.index;
    if (descriptor.sourceIndex === ownSourceIndex) {
      contourToElement[descriptor.contourIndex] = element.index;
    }
    if (descriptor.componentIndex != null) {
      if (!componentToElements[descriptor.componentIndex]) {
        componentToElements[descriptor.componentIndex] = [];
      }
      if (!componentToElements[descriptor.componentIndex].includes(element.index)) {
        componentToElements[descriptor.componentIndex].push(element.index);
      }
    }
  }

  const componentShapeCounts = new Map();
  for (const element of elements) {
    if (element.componentIndex != null) {
      componentShapeCounts.set(
        element.componentIndex,
        (componentShapeCounts.get(element.componentIndex) || 0) + 1
      );
    }
  }
  const componentShapeOrdinals = new Map();
  for (const element of elements) {
    if (element.componentIndex == null) {
      element.label = `Contour ${element.rootContourIndex + 1}`;
      continue;
    }
    const ordinal =
      (componentShapeOrdinals.get(element.componentIndex) || 0) + 1;
    componentShapeOrdinals.set(element.componentIndex, ordinal);
    const total = componentShapeCounts.get(element.componentIndex) || 1;
    element.label =
      total > 1
        ? `Component ${element.componentIndex + 1} · ${ordinal}`
        : `Component ${element.componentIndex + 1}`;
  }

  return {
    elements,
    contourToElement,
    componentToElements,
    flattenedContourToElement,
    contourCount: flattenedCount,
  };
}
