import assert from "node:assert/strict";
import test from "node:test";
import { assessEnvironmentAssetPublication } from "./environmentAssetPublication.mjs";

const hash = "a".repeat(64);
const file = (fileName) => ({ fileName, bytes: 1024, sha256: hash });

test("publishes a complete HDRI record", () => {
  const result = assessEnvironmentAssetPublication({
    category: "environment",
    maps: [{ kind: "environment", fileName: "environment.hdr" }],
    files: [file("environment.hdr"), file("thumbnail.png")],
  });
  assert.deepEqual(result, { ready: true, issues: [] });
});

test("publishes a complete PBR record", () => {
  const result = assessEnvironmentAssetPublication({
    category: "material",
    maps: [
      { kind: "base-color", fileName: "base-color.jpg" },
      { kind: "normal", fileName: "normal.jpg" },
      { kind: "roughness", fileName: "roughness.jpg" },
    ],
    files: [file("base-color.jpg"), file("normal.jpg"), file("roughness.jpg"), file("thumbnail.png")],
  });
  assert.equal(result.ready, true);
});

test("blocks missing previews, missing maps and broken integrity metadata", () => {
  const result = assessEnvironmentAssetPublication({
    category: "material",
    maps: [{ kind: "base-color", fileName: "base-color.jpg" }],
    files: [{ fileName: "base-color.jpg", bytes: 0, sha256: "broken" }],
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.issues, [
    "missing-map:normal",
    "missing-map:roughness",
    "missing-thumbnail",
    "invalid-integrity:base-color.jpg",
  ]);
});
