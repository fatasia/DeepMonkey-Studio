import assert from "node:assert/strict";
import test from "node:test";
import { assessExternalAssetQuality } from "./assetQualityAudit.mjs";

const model = { name: "六轴机械臂", type: { name: "工业场景" }, element: { name: "机器人" }, style: { name: "写实" } };
const audit = { valid: true, qualityTier: "light", meshCount: 2, primitiveCount: 3, materialCount: 1, dimensions: { x: 1, y: 2, z: 1 } };

test("accepts a structurally complete model with a qualified thumbnail", () => {
  const result = assessExternalAssetQuality(model, audit, { valid: true, qualityScore: 92 });
  assert.equal(result.status, "ready");
  assert.ok(result.qualityScore >= 90);
});

test("keeps duplicates and broken thumbnails out of the published catalog", () => {
  const result = assessExternalAssetQuality(model, { ...audit, duplicateOf: "models/10.glb" }, { valid: false, qualityScore: 0 });
  assert.equal(result.status, "review-required");
  assert.ok(result.issues.includes("duplicate-content"));
  assert.ok(result.issues.includes("thumbnail-unqualified"));
});
