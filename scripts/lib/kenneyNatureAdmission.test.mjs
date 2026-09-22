import test from "node:test";
import assert from "node:assert/strict";
import manifest from "../../docs/specs/de26-v11-kenney-nature-admission-manifest-2026-09-18.json" with { type: "json" };
import { evaluateKenneyNatureAdmission } from "./kenneyNatureAdmission.mjs";

const audit = {
  archiveSha256: manifest.archive.sha256,
  selectedCounts: { ...manifest.selection.categories, total: manifest.selection.total },
  selectedGeometry: {
    positionAccessor: `all ${manifest.selection.total} selected GLBs contain float32 VEC3 POSITION accessors`,
    nonFinitePositionValues: 0,
    origin: { outlier: { path: "Models/GLTF format/fence_gate.glb", minY: -0.1702811569 } },
  },
  thumbnailAudit: {
    selectedWithAtLeastFourIsometricViews: manifest.selection.total,
    selectedMissingIsometricViews: 0,
  },
};

test("Kenney V11 admission stays fail-closed on fence_gate grounding outlier", () => {
  assert.deepEqual(evaluateKenneyNatureAdmission(manifest, audit), {
    status: "blocked",
    blocked: [{ path: "Models/GLTF format/fence_gate.glb", minY: -0.1702811569, reason: "model origin is below ground" }],
  });
});

test("Kenney V11 admission rejects a silently cleared fence gate", () => {
  const changed = structuredClone(audit);
  changed.selectedGeometry.origin.outlier = undefined;
  assert.throws(() => evaluateKenneyNatureAdmission(manifest, changed), /grounded-origin fence gate drifted/);
});
