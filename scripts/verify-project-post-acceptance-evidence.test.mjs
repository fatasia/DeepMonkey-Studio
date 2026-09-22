import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

test("D24-D28 evidence packet is reproducible and remains partial", async () => {
  const report = JSON.parse(await fs.readFile("test-output/d24-d28-post-acceptance-20260919/evidence.json", "utf8"));
  assert.equal(report.schema, "deep-engine.d24-d28-post-acceptance-evidence.v1");
  assert.equal(report.verdict, "partial");
  assert.ok(report.pairedAssetRows.length >= 4);
  assert.equal(report.checks.pairedEvidenceReferencesPresent, true);
  assert.equal(report.checks.hasIndependentNativeOpponentEvidence, false);
  assert.equal(report.checks.hasLongStabilityEvidence, false);
});
