import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// A tiny canvas mock. The engine only needs a 2D context that can fill paths,
// read back pixels, and composite element images. Rasterizing polygons with a
// nonzero winding rule is enough to exercise the per-element crop and focus
// logic without a browser.
// ---------------------------------------------------------------------------

class MockPath2D {
  constructor() {
    this.contours = [];
  }

  addContour(points) {
    this.contours.push(points.map((point) => ({ x: point.x, y: point.y })));
  }
}

class MockCanvas {
  constructor() {
    this._width = 0;
    this._height = 0;
    this.buffer = new Uint8ClampedArray(0);
    this._context = new MockContext(this);
  }

  get width() {
    return this._width;
  }

  set width(value) {
    this._width = value;
    this._allocate();
  }

  get height() {
    return this._height;
  }

  set height(value) {
    this._height = value;
    this._allocate();
  }

  _allocate() {
    this.buffer = new Uint8ClampedArray(
      Math.max(0, this._width * this._height * 4)
    );
  }

  getContext() {
    return this._context;
  }
}

class MockContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.globalAlpha = 1;
    this.imageSmoothingEnabled = true;
    this.fillStyle = "#fff";
    this._matrix = [1, 0, 0, 1, 0, 0];
    this._stack = [];
  }

  get buffer() {
    return this.canvas.buffer;
  }

  get width() {
    return this.canvas.width;
  }

  get height() {
    return this.canvas.height;
  }

  save() {
    this._stack.push({
      matrix: [...this._matrix],
      globalAlpha: this.globalAlpha,
    });
  }

  restore() {
    const state = this._stack.pop();
    if (state) {
      this._matrix = state.matrix;
      this.globalAlpha = state.globalAlpha;
    }
  }

  setTransform(a, b, c, d, e, f) {
    this._matrix = [a, b, c, d, e, f];
  }

  _transform(point) {
    const [a, b, c, d, e, f] = this._matrix;
    return {
      x: a * point.x + c * point.y + e,
      y: b * point.x + d * point.y + f,
    };
  }

  clearRect() {
    this.buffer.fill(0);
  }

  fill(path) {
    const contours = (path?.contours || []).map((contour) =>
      contour.map((point) => this._transform(point))
    );
    const width = this.width;
    const height = this.height;
    for (let y = 0; y < height; y++) {
      const scanY = y + 0.5;
      const crossings = [];
      for (const contour of contours) {
        for (let i = 0; i < contour.length; i++) {
          const a = contour[i];
          const b = contour[(i + 1) % contour.length];
          if (a.y <= scanY !== b.y <= scanY) {
            const t = (scanY - a.y) / (b.y - a.y);
            crossings.push({
              x: a.x + (b.x - a.x) * t,
              direction: b.y > a.y ? 1 : -1,
            });
          }
        }
      }
      if (!crossings.length) {
        continue;
      }
      crossings.sort((a, b) => a.x - b.x);
      let winding = 0;
      let spanStart = null;
      for (const crossing of crossings) {
        const previous = winding;
        winding += crossing.direction;
        if (previous === 0 && winding !== 0) {
          spanStart = crossing.x;
        } else if (previous !== 0 && winding === 0 && spanStart != null) {
          const start = Math.max(0, Math.ceil(spanStart - 0.5));
          const end = Math.min(width - 1, Math.floor(crossing.x - 0.5));
          for (let x = start; x <= end; x++) {
            this.buffer[(y * width + x) * 4 + 3] = 255;
          }
          spanStart = null;
        }
      }
    }
  }

  getImageData(x, y, width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row++) {
      const sourceY = y + row;
      if (sourceY < 0 || sourceY >= this.height) {
        continue;
      }
      for (let column = 0; column < width; column++) {
        const sourceX = x + column;
        if (sourceX < 0 || sourceX >= this.width) {
          continue;
        }
        const source = (sourceY * this.width + sourceX) * 4;
        const target = (row * width + column) * 4;
        data[target] = this.buffer[source];
        data[target + 1] = this.buffer[source + 1];
        data[target + 2] = this.buffer[source + 2];
        data[target + 3] = this.buffer[source + 3];
      }
    }
    return { data, width, height };
  }

  createImageData(width, height) {
    return {
      data: new Uint8ClampedArray(width * height * 4),
      width,
      height,
    };
  }

  putImageData(imageData, dx, dy) {
    for (let row = 0; row < imageData.height; row++) {
      const targetY = dy + row;
      if (targetY < 0 || targetY >= this.height) {
        continue;
      }
      for (let column = 0; column < imageData.width; column++) {
        const targetX = dx + column;
        if (targetX < 0 || targetX >= this.width) {
          continue;
        }
        const source = (row * imageData.width + column) * 4;
        const target = (targetY * this.width + targetX) * 4;
        this.buffer[target] = imageData.data[source];
        this.buffer[target + 1] = imageData.data[source + 1];
        this.buffer[target + 2] = imageData.data[source + 2];
        this.buffer[target + 3] = imageData.data[source + 3];
      }
    }
  }

  drawImage(image, dx, dy) {
    const source = image.buffer;
    const sourceWidth = image.width;
    const sourceHeight = image.height;
    const alpha = this.globalAlpha;
    for (let row = 0; row < sourceHeight; row++) {
      const targetY = dy + row;
      if (targetY < 0 || targetY >= this.height) {
        continue;
      }
      for (let column = 0; column < sourceWidth; column++) {
        const targetX = dx + column;
        if (targetX < 0 || targetX >= this.width) {
          continue;
        }
        const sourceIndex = (row * sourceWidth + column) * 4;
        const sourceAlpha = (source[sourceIndex + 3] / 255) * alpha;
        if (sourceAlpha <= 0) {
          continue;
        }
        const targetIndex = (targetY * this.width + targetX) * 4;
        const targetAlpha = this.buffer[targetIndex + 3] / 255;
        const outAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
        if (outAlpha <= 0) {
          continue;
        }
        for (let channel = 0; channel < 3; channel++) {
          this.buffer[targetIndex + channel] =
            (source[sourceIndex + channel] * sourceAlpha +
              this.buffer[targetIndex + channel] *
                targetAlpha *
                (1 - sourceAlpha)) /
            outAlpha;
        }
        this.buffer[targetIndex + 3] = outAlpha * 255;
      }
    }
  }
}

globalThis.Path2D = MockPath2D;
globalThis.document = {
  createElement(tag) {
    assert.equal(tag, "canvas");
    return new MockCanvas();
  },
};

const { ThicknessEngine } = await import("../src/engine.js");
const { normalizeSettings } = await import("../src/core.js");

function square(xMin, yMin, xMax, yMax) {
  return [
    { x: xMin, y: yMin },
    { x: xMax, y: yMin },
    { x: xMax, y: yMax },
    { x: xMin, y: yMax },
  ];
}

function reversed(points) {
  return [...points].reverse();
}

function makePath(contours) {
  let endPoint = -1;
  return {
    numContours: contours.length,
    contourInfo: contours.map((contour) => {
      endPoint += contour.length;
      return { endPoint, isClosed: true };
    }),
    *iterContourDecomposedSegments(contourIndex) {
      const points = contours[contourIndex];
      for (let i = 0; i < points.length; i++) {
        yield {
          type: "line",
          points: [points[i], points[(i + 1) % points.length]],
        };
      }
    },
    drawContourToPath2d(path2d, contourIndex) {
      path2d.addContour(contours[contourIndex]);
    },
    contours,
  };
}

function boundsOf(paths) {
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const path of paths) {
    for (const contour of path.contours) {
      for (const point of contour) {
        xMin = Math.min(xMin, point.x);
        yMin = Math.min(yMin, point.y);
        xMax = Math.max(xMax, point.x);
        yMax = Math.max(yMax, point.y);
      }
    }
  }
  return { xMin, yMin, xMax, yMax };
}

function makePositionedGlyph(ownPath, componentPaths = []) {
  const path2d = new MockPath2D();
  for (const contour of ownPath.contours) {
    path2d.addContour(contour);
  }
  for (const componentPath of componentPaths) {
    for (const contour of componentPath.contours) {
      path2d.addContour(contour);
    }
  }
  const allPaths = [ownPath, ...componentPaths];
  const bounds = boundsOf(allPaths);
  const glyph = {
    path: ownPath,
    components: componentPaths.map((path) => ({ path })),
    flattenedPath2d: path2d,
    controlBounds: bounds,
  };
  return {
    glyph,
    x: 0,
    y: 0,
    unpositionedBounds: bounds,
  };
}

function baseSettings(overrides = {}) {
  return normalizeSettings({
    perElement: true,
    displayMode: "measured",
    quality: "fast",
    opacity: 1,
    baseThickness: 100,
    tolerance: 5,
    ...overrides,
  });
}

function alphaAt(analysis, canvas, x, y) {
  const pixelX = Math.floor((x - analysis.originX) * analysis.scale);
  const pixelY = Math.floor((y - analysis.originY) * analysis.scale);
  if (
    pixelX < 0 ||
    pixelY < 0 ||
    pixelX >= canvas.width ||
    pixelY >= canvas.height
  ) {
    return 0;
  }
  return canvas.buffer[(pixelY * canvas.width + pixelX) * 4 + 3];
}

function elementAlphaAt(element, x, y) {
  const analysis = element.analysis;
  const pixelX = Math.floor((x - analysis.originX) * analysis.scale);
  const pixelY = Math.floor((y - analysis.originY) * analysis.scale);
  if (
    pixelX < 0 ||
    pixelY < 0 ||
    pixelX >= analysis.width ||
    pixelY >= analysis.height
  ) {
    return 0;
  }
  return analysis.mask[pixelY * analysis.width + pixelX] ? 255 : 0;
}

function analyze(positionedGlyph, overrides = {}) {
  const engine = new ThicknessEngine();
  const settings = baseSettings(overrides);
  const analysis = engine.getAnalysis(positionedGlyph, settings);
  assert.ok(analysis, "expected an analysis");
  return { engine, settings, analysis };
}

test("per-element analysis groups disjoint contours and maps points", () => {
  const ownPath = makePath([square(0, 0, 100, 100), square(200, 0, 300, 100)]);
  const { analysis } = analyze(makePositionedGlyph(ownPath));

  assert.equal(analysis.perElement, true);
  assert.equal(analysis.elements.length, 2);
  assert.ok(analysis.elements.every((element) => element.analysis));
  assert.deepEqual(analysis.contourToElement, [0, 1]);
  assert.deepEqual(analysis.pointToElement, [0, 0, 0, 0, 1, 1, 1, 1]);
  assert.deepEqual(analysis.flattenedContourToElement, [0, 1]);
  assert.ok(analysis.stats.count > 0);
  assert.ok(analysis.elements[0].analysis.stats.count > 0);
  assert.ok(analysis.elements[1].analysis.stats.count > 0);
});

test("selected focus fades the other elements and follows point indices", () => {
  const ownPath = makePath([square(0, 0, 100, 100), square(200, 0, 300, 100)]);
  const { engine, analysis } = analyze(makePositionedGlyph(ownPath), {
    elementFocus: "selected",
  });

  const first = engine.getImage(analysis, baseSettings({ elementFocus: "selected" }), {
    selection: new Set(["point/0"]),
  });
  assert.ok(first);
  assert.ok(alphaAt(analysis, first, 50, 50) > 100);
  assert.ok(alphaAt(analysis, first, 250, 50) < 60);

  const second = engine.getImage(analysis, baseSettings({ elementFocus: "selected" }), {
    selection: new Set(["point/4"]),
  });
  assert.ok(second);
  assert.ok(alphaAt(analysis, second, 250, 50) > 100);
  assert.ok(alphaAt(analysis, second, 50, 50) < 60);
});

test("hovered focus uses a point selection, a path hit, or a glyph point", () => {
  const ownPath = makePath([square(0, 0, 100, 100), square(200, 0, 300, 100)]);
  const { engine, analysis } = analyze(makePositionedGlyph(ownPath), {
    elementFocus: "hovered",
  });
  const settings = baseSettings({ elementFocus: "hovered" });

  const bySelection = engine.getImage(analysis, settings, {
    hoverSelection: new Set(["point/0"]),
  });
  assert.ok(bySelection);
  assert.ok(alphaAt(analysis, bySelection, 50, 50) > 100);
  assert.ok(alphaAt(analysis, bySelection, 250, 50) < 60);

  const byPathHit = engine.getImage(analysis, settings, {
    hoverPathHit: { contourIndex: 1 },
  });
  assert.ok(byPathHit);
  assert.ok(alphaAt(analysis, byPathHit, 250, 50) > 100);
  assert.ok(alphaAt(analysis, byPathHit, 50, 50) < 60);

  const byPoint = engine.getImage(analysis, settings, {
    glyphPoint: { x: 250, y: 50 },
  });
  assert.ok(byPoint);
  assert.ok(alphaAt(analysis, byPoint, 250, 50) > 100);
  assert.ok(alphaAt(analysis, byPoint, 50, 50) < 60);
});

test("a counter is cut out of its element", () => {
  const ownPath = makePath([
    square(0, 0, 100, 100),
    reversed(square(20, 20, 80, 80)),
  ]);
  const { analysis } = analyze(makePositionedGlyph(ownPath));

  assert.equal(analysis.elements.length, 1);
  assert.equal(analysis.elements[0].holeContours.length, 1);
  assert.equal(elementAlphaAt(analysis.elements[0], 50, 50), 0);
  assert.equal(elementAlphaAt(analysis.elements[0], 10, 50), 255);
});

test("an island inside a counter is its own focusable element", () => {
  const ownPath = makePath([
    square(0, 0, 100, 100),
    reversed(square(20, 20, 80, 80)),
    square(40, 40, 60, 60),
  ]);
  const { engine, analysis } = analyze(makePositionedGlyph(ownPath), {
    elementFocus: "selected",
  });

  assert.equal(analysis.elements.length, 2);
  assert.deepEqual(analysis.pointToElement, [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);

  const image = engine.getImage(analysis, baseSettings({ elementFocus: "selected" }), {
    selection: new Set(["point/8"]),
  });
  assert.ok(image);
  assert.ok(alphaAt(analysis, image, 50, 50) > 100);
  assert.ok(alphaAt(analysis, image, 10, 50) < 60);
});

test("components are measured and focused independently", () => {
  const ownPath = makePath([square(0, 0, 50, 50)]);
  const componentPath = makePath([square(100, 0, 150, 50)]);
  const { engine, analysis } = analyze(
    makePositionedGlyph(ownPath, [componentPath]),
    { elementFocus: "selected" }
  );

  assert.equal(analysis.elements.length, 2);
  assert.deepEqual(analysis.componentToElements[0], [1]);
  assert.deepEqual(analysis.flattenedContourToElement, [0, 1]);

  const selected = engine.getImage(
    analysis,
    baseSettings({ elementFocus: "selected" }),
    { selection: new Set(["component/0"]) }
  );
  assert.ok(selected);
  assert.ok(alphaAt(analysis, selected, 125, 25) > 100);
  assert.ok(alphaAt(analysis, selected, 25, 25) < 60);

  const hovered = engine.getImage(
    analysis,
    baseSettings({ elementFocus: "hovered" }),
    { hoverSelection: new Set(["component/0"]) }
  );
  assert.ok(hovered);
  assert.ok(alphaAt(analysis, hovered, 125, 25) > 100);
  assert.ok(alphaAt(analysis, hovered, 25, 25) < 60);
});

test("a component with a counter keeps its hole", () => {
  const ownPath = makePath([]);
  const componentPath = makePath([
    square(100, 0, 200, 100),
    reversed(square(120, 20, 180, 80)),
  ]);
  const { analysis } = analyze(makePositionedGlyph(ownPath, [componentPath]));

  assert.equal(analysis.elements.length, 1);
  assert.equal(analysis.elements[0].holeContours.length, 1);
  assert.deepEqual(analysis.componentToElements[0], [0]);
  assert.equal(elementAlphaAt(analysis.elements[0], 150, 50), 0);
  assert.equal(elementAlphaAt(analysis.elements[0], 110, 50), 255);
});

test("overlapping contours stay separate and focus on top", () => {
  const ownPath = makePath([square(0, 0, 100, 100), square(50, 50, 150, 150)]);
  const { engine, analysis } = analyze(makePositionedGlyph(ownPath), {
    elementFocus: "selected",
  });

  assert.equal(analysis.elements.length, 2);
  assert.equal(analysis.elements[0].holeContours.length, 0);
  assert.equal(analysis.elements[1].holeContours.length, 0);
  assert.ok(Math.abs(analysis.elements[0].analysis.stats.actualMedian - 100) < 12);
  assert.ok(Math.abs(analysis.elements[1].analysis.stats.actualMedian - 100) < 12);

  const image = engine.getImage(analysis, baseSettings({ elementFocus: "selected" }), {
    selection: new Set(["point/0"]),
  });
  assert.ok(image);
  assert.ok(alphaAt(analysis, image, 25, 25) > 100);
  assert.ok(alphaAt(analysis, image, 125, 125) < 60);
  // The focused element is composited last, so it wins in the overlap.
  assert.ok(alphaAt(analysis, image, 75, 75) > 100);
});
