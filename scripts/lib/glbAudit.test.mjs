import assert from "node:assert/strict";
import test from "node:test";
import { classifyQuality, summarizeGlbDocument } from "./glbAudit.mjs";

test("summarizes triangles, animations and declared bounds", () => {
  const metrics = summarizeGlbDocument({
    asset: { version: "2.0", generator: "fixture" },
    scenes: [{}],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ indices: 0, attributes: { POSITION: 1 } }] }],
    accessors: [
      { count: 300 },
      { count: 120, min: [-2, 0, -1], max: [2, 3, 5] },
    ],
    materials: [{}],
    textures: [{}],
    animations: [{}],
  });
  assert.equal(metrics.triangleCount, 100);
  assert.equal(metrics.animationCount, 1);
  assert.deepEqual(metrics.dimensions, { x: 4, y: 3, z: 6 });
  assert.equal(classifyQuality(1024, metrics), "light");
});

test("sends externally referenced or empty geometry to review", () => {
  const external = summarizeGlbDocument({ buffers: [{ uri: "mesh.bin" }], meshes: [] });
  assert.equal(classifyQuality(1024, external), "review");
});
