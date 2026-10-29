import test from "node:test";
import assert from "node:assert/strict";

import {
  flattenContour,
  groupContourSources,
  signedArea,
} from "../src/elements.js";

function makePath(contours) {
  return {
    numContours: contours.length,
    contourInfo: contours.map((points) => ({
      endPoint: points.length - 1,
      isClosed: true,
    })),
    *iterContourDecomposedSegments(contourIndex) {
      const points = contours[contourIndex];
      for (let i = 0; i < points.length; i++) {
        yield {
          type: "line",
          points: [points[i], points[(i + 1) % points.length]],
        };
      }
    },
  };
}

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

function ownSource(path) {
  return [{ path, componentIndex: null }];
}

test("flattenContour returns a closed square without a duplicate point", () => {
  const path = makePath([square(0, 0, 10, 10)]);
  const points = flattenContour(path, 0);
  assert.equal(points.length, 4);
  assert.equal(signedArea(points), 100);
});

test("disjoint contours become separate elements", () => {
  const path = makePath([square(0, 0, 10, 10), square(20, 0, 30, 10)]);
  const grouped = groupContourSources(ownSource(path));
  assert.equal(grouped.elements.length, 2);
  assert.equal(grouped.elements[0].solidContours.length, 1);
  assert.equal(grouped.elements[0].holeContours.length, 0);
  assert.equal(grouped.elements[1].solidContours.length, 1);
  assert.deepEqual(grouped.contourToElement, [0, 1]);
  assert.deepEqual(grouped.flattenedContourToElement, [0, 1]);
});

test("an opposite-winding inner contour becomes a counter", () => {
  const path = makePath([
    square(0, 0, 100, 100),
    reversed(square(20, 20, 80, 80)),
  ]);
  const grouped = groupContourSources(ownSource(path));
  assert.equal(grouped.elements.length, 1);
  assert.equal(grouped.elements[0].solidContours.length, 1);
  assert.equal(grouped.elements[0].holeContours.length, 1);
  assert.deepEqual(grouped.contourToElement, [0, 0]);
});

test("a same-winding inner contour does not subtract ink", () => {
  const path = makePath([square(0, 0, 100, 100), square(20, 20, 80, 80)]);
  const grouped = groupContourSources(ownSource(path));
  assert.equal(grouped.elements.length, 1);
  assert.equal(grouped.elements[0].solidContours.length, 2);
  assert.equal(grouped.elements[0].holeContours.length, 0);
});

test("an island inside a counter is its own element", () => {
  const path = makePath([
    square(0, 0, 100, 100),
    reversed(square(20, 20, 80, 80)),
    square(40, 40, 60, 60),
  ]);
  const grouped = groupContourSources(ownSource(path));
  assert.equal(grouped.elements.length, 2);
  assert.equal(grouped.elements[0].holeContours.length, 1);
  assert.equal(grouped.elements[1].holeContours.length, 0);
  assert.deepEqual(grouped.contourToElement, [0, 0, 1]);
});

test("overlapping contours stay separate instead of becoming counters", () => {
  const path = makePath([square(0, 0, 60, 60), square(40, 40, 100, 100)]);
  const grouped = groupContourSources(ownSource(path));
  assert.equal(grouped.elements.length, 2);
  assert.equal(grouped.elements[0].holeContours.length, 0);
  assert.equal(grouped.elements[1].holeContours.length, 0);
});

test("components are separate elements with their own mapping", () => {
  const ownPath = makePath([square(0, 0, 10, 10)]);
  const componentPath = makePath([square(20, 0, 30, 10)]);
  const grouped = groupContourSources([
    { path: ownPath, componentIndex: null },
    { path: componentPath, componentIndex: 0 },
  ]);
  assert.equal(grouped.elements.length, 2);
  assert.equal(grouped.elements[1].componentIndex, 0);
  assert.deepEqual(grouped.componentToElements[0], [1]);
  assert.deepEqual(grouped.contourToElement, [0]);
  assert.deepEqual(grouped.flattenedContourToElement, [0, 1]);
});

test("a component with a counter is one element with a hole", () => {
  const componentPath = makePath([
    square(0, 0, 100, 100),
    reversed(square(20, 20, 80, 80)),
  ]);
  const grouped = groupContourSources([
    { path: makePath([]), componentIndex: null },
    { path: componentPath, componentIndex: 0 },
  ]);
  assert.equal(grouped.elements.length, 1);
  assert.equal(grouped.elements[0].holeContours.length, 1);
  assert.deepEqual(grouped.componentToElements[0], [0]);
  assert.deepEqual(grouped.flattenedContourToElement, [0, 0]);
});
