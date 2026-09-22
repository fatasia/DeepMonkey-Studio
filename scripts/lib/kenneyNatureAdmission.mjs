import assert from "node:assert/strict";

export function evaluateKenneyNatureAdmission(manifest, audit) {
  assert.equal(manifest.schemaVersion, 1, "unsupported Kenney admission manifest");
  assert.equal(audit.archiveSha256, manifest.archive.sha256, "archive SHA-256 changed");
  assert.equal(audit.selectedCounts.total, manifest.selection.total, "selected template count changed");
  const { total: _total, ...categoryCounts } = audit.selectedCounts;
  assert.deepEqual(categoryCounts, manifest.selection.categories, "selected category counts changed");
  assert.equal(audit.selectedGeometry.positionAccessor,
    `all ${manifest.selection.total} selected GLBs contain float32 VEC3 POSITION accessors`);
  assert.equal(audit.selectedGeometry.nonFinitePositionValues, manifest.selection.required.nonFinitePositionValues, "non-finite positions found");
  assert.equal(audit.thumbnailAudit.selectedMissingIsometricViews, 0, "selected template is missing an isometric thumbnail");
  assert.ok(audit.thumbnailAudit.selectedWithAtLeastFourIsometricViews >= manifest.selection.total,
    "selected template is missing the required isometric view set");
  const gate = manifest.admission.fenceGate;
  const outlier = audit.selectedGeometry.origin.outlier;
  const blocked = outlier && Math.abs(outlier.minY) > gate.maxAbsMinY ? [{ ...outlier, reason: "model origin is below ground" }] : [];
  assert.deepEqual(blocked, gate.blocked, "grounded-origin fence gate drifted");
  return { status: blocked.length ? "blocked" : "ready", blocked };
}
