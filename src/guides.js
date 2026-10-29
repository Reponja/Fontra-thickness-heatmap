/*
 * Flow-guide data: user-drawn polylines that tell the thickness measurement
 * which way a stroke flows. The drawing and measurement code live elsewhere;
 * this module only normalizes, simplifies, persists, and fingerprints guides.
 *
 * A guide is an array of `{x, y}` points in glyph coordinates. A glyph's guide
 * set is an array of such polylines. The global guide mode (drawn across the
 * stroke or along it) is a setting, not part of the stored geometry.
 */

export const FLOW_GUIDE_MODES = ["across", "along"];

const MAX_GUIDES_PER_GLYPH = 48;
const MAX_POINTS_PER_GUIDE = 512;
const COORDINATE_LIMIT = 1e7;

function finitePoint(point) {
  if (!point || typeof point !== "object") {
    return null;
  }
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return {
    x: Math.max(-COORDINATE_LIMIT, Math.min(COORDINATE_LIMIT, x)),
    y: Math.max(-COORDINATE_LIMIT, Math.min(COORDINATE_LIMIT, y)),
  };
}

function pointDistanceSquared(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * Keep the stored data small and predictable. Consecutive duplicate points are
 * dropped, non-finite coordinates are rejected, and each guide is capped.
 */
export function normalizeFlowGuides(rawGuides) {
  if (!Array.isArray(rawGuides)) {
    return [];
  }
  const guides = [];
  for (const rawGuide of rawGuides) {
    const rawPoints = Array.isArray(rawGuide)
      ? rawGuide
      : Array.isArray(rawGuide?.points)
        ? rawGuide.points
        : null;
    if (!rawPoints) {
      continue;
    }
    const points = [];
    for (const rawPoint of rawPoints) {
      const point = finitePoint(rawPoint);
      if (!point) {
        continue;
      }
      const previous = points[points.length - 1];
      if (previous && pointDistanceSquared(previous, point) < 1e-10) {
        continue;
      }
      points.push(point);
      if (points.length >= MAX_POINTS_PER_GUIDE) {
        break;
      }
    }
    if (points.length >= 2) {
      guides.push(points);
    }
    if (guides.length >= MAX_GUIDES_PER_GLYPH) {
      break;
    }
  }
  return guides;
}

function perpendicularDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-12) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  const t =
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
  const clamped = Math.max(0, Math.min(1, t));
  return Math.hypot(
    point.x - (start.x + dx * clamped),
    point.y - (start.y + dy * clamped)
  );
}

/**
 * Ramer-Douglas-Peucker simplification. Freehand pointer samples are noisy and
 * would make the local guide tangent wobble; simplify with a tolerance in font
 * units before storing.
 */
export function simplifyFlowGuide(points, tolerance) {
  const normalized = normalizeFlowGuides([points])[0];
  if (!normalized) {
    return [];
  }
  if (!(tolerance > 0) || normalized.length <= 2) {
    return normalized;
  }

  const keep = new Uint8Array(normalized.length);
  keep[0] = 1;
  keep[normalized.length - 1] = 1;
  const stack = [[0, normalized.length - 1]];

  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDistance = -1;
    let maxIndex = -1;
    for (let i = first + 1; i < last; i++) {
      const distance = perpendicularDistance(
        normalized[i],
        normalized[first],
        normalized[last]
      );
      if (distance > maxDistance) {
        maxDistance = distance;
        maxIndex = i;
      }
    }
    if (maxIndex >= 0 && maxDistance > tolerance) {
      keep[maxIndex] = 1;
      stack.push([first, maxIndex], [maxIndex, last]);
    }
  }

  return normalized.filter((_, index) => keep[index]);
}

export function flowGuideLength(points) {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(
      points[i].x - points[i - 1].x,
      points[i].y - points[i - 1].y
    );
  }
  return length;
}

/**
 * Stable analysis-cache key. Coordinates are quantized to 1/100 unit, which is
 * far below what the raster can resolve.
 */
export function flowGuideSignature(guides, mode = "across") {
  const normalizedMode = FLOW_GUIDE_MODES.includes(mode) ? mode : "across";
  return (
    `guides:${normalizedMode}:` +
    normalizeFlowGuides(guides)
      .map((points) =>
        points
          .map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`)
          .join(" ")
      )
      .join(";")
  );
}

export class FlowGuideStore {
  constructor(storageKey) {
    this.storageKey = storageKey;
    this._data = {};
    this._load();
  }

  _load() {
    try {
      const raw = globalThis.localStorage?.getItem(this.storageKey);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }
      const data = {};
      for (const [glyphName, guides] of Object.entries(parsed)) {
        const normalized = normalizeFlowGuides(guides);
        if (normalized.length) {
          data[glyphName] = normalized;
        }
      }
      this._data = data;
    } catch (error) {
      // localStorage may be unavailable or contain corrupt data. Guides remain
      // usable for this session, they just don't persist.
      this._data = {};
    }
  }

  get(glyphName) {
    if (!glyphName) {
      return [];
    }
    return normalizeFlowGuides(this._data[glyphName]);
  }

  has(glyphName) {
    return this.get(glyphName).length > 0;
  }

  set(glyphName, guides) {
    if (!glyphName) {
      return [];
    }
    const normalized = normalizeFlowGuides(guides);
    if (normalized.length) {
      this._data[glyphName] = normalized;
    } else {
      delete this._data[glyphName];
    }
    this._save();
    return normalized;
  }

  add(glyphName, points) {
    const normalizeGuide = normalizeFlowGuides([points])[0];
    if (!normalizeGuide) {
      return this.get(glyphName);
    }
    return this.set(glyphName, [...this.get(glyphName), normalizeGuide]);
  }

  undoLast(glyphName) {
    const guides = this.get(glyphName);
    guides.pop();
    return this.set(glyphName, guides);
  }

  clear(glyphName) {
    return this.set(glyphName, []);
  }

  _save() {
    try {
      if (Object.keys(this._data).length) {
        globalThis.localStorage?.setItem(
          this.storageKey,
          JSON.stringify(this._data)
        );
      } else {
        globalThis.localStorage?.removeItem(this.storageKey);
      }
    } catch (error) {
      // See _load().
    }
  }
}
