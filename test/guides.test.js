import test from "node:test";
import assert from "node:assert/strict";

import {
  FlowGuideStore,
  flowGuideLength,
  flowGuideSignature,
  normalizeFlowGuides,
  simplifyFlowGuide,
} from "../src/guides.js";

test("flow-guide normalization drops malformed and duplicate points", () => {
  const guides = normalizeFlowGuides([
    [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: Number.NaN, y: 4 },
      { x: 10, y: 10 },
    ],
    [{ x: 1, y: 2 }],
    "nonsense",
    [{ x: 4, y: 5 }, { x: 8, y: 9 }],
  ]);

  assert.deepEqual(guides, [
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
    [
      { x: 4, y: 5 },
      { x: 8, y: 9 },
    ],
  ]);
});

test("flow-guide simplification removes collinear freehand noise", () => {
  const points = [];
  for (let i = 0; i <= 20; i++) {
    points.push({ x: i * 10, y: i % 2 ? 0.2 : -0.2 });
  }
  const simplified = simplifyFlowGuide(points, 1);
  assert.equal(simplified.length, 2);
  assert.deepEqual(simplified[0], { x: 0, y: -0.2 });
  assert.deepEqual(simplified[1], { x: 200, y: -0.2 });
  assert.ok(Math.abs(flowGuideLength(points) - 200) < 0.2);
});

test("flow-guide signatures include geometry and direction mode", () => {
  const guides = [
    [
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ],
  ];
  assert.equal(
    flowGuideSignature(guides, "across"),
    flowGuideSignature(guides, "across")
  );
  assert.notEqual(
    flowGuideSignature(guides, "across"),
    flowGuideSignature(guides, "along")
  );
  assert.notEqual(
    flowGuideSignature(guides, "across"),
    flowGuideSignature(
      [
        [
          { x: 10, y: 20 },
          { x: 31, y: 40 },
        ],
      ],
      "across"
    )
  );
});

test("guide store persists per glyph and supports undo and clear", () => {
  const storage = new Map();
  globalThis.localStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    },
  };

  try {
    const store = new FlowGuideStore("test-flow-guides");
    store.add("a", [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    store.add("a", [
      { x: 0, y: 10 },
      { x: 10, y: 10 },
    ]);
    store.add("b", [
      { x: 0, y: 0 },
      { x: 0, y: 10 },
    ]);

    assert.equal(store.get("a").length, 2);
    assert.equal(store.get("b").length, 1);

    const reloaded = new FlowGuideStore("test-flow-guides");
    assert.equal(reloaded.get("a").length, 2);
    assert.equal(reloaded.get("b").length, 1);

    reloaded.undoLast("a");
    assert.equal(reloaded.get("a").length, 1);
    assert.equal(reloaded.get("b").length, 1);

    reloaded.clear("a");
    assert.deepEqual(reloaded.get("a"), []);
    assert.equal(reloaded.get("b").length, 1);
  } finally {
    delete globalThis.localStorage;
  }
});
