import assert from "node:assert/strict";
import test from "node:test";
import { evaluateGiClosureMatrix } from "./giClosureEvidence.mjs";

const cell = (kind) => ({ kind, metrics: { ssim: 0.8 },
  exposureNormalized: { normalizedSsim: 0.97, normalizedMae: 0.03 }, edgeBand: { f1: 0.9 } });
const matrix = () => ({ schemaVersion: 2, cells: [cell("on"), cell("off")] });

test("reads schema v2 normalized metrics and includes exact thresholds", () => {
  const result = evaluateGiClosureMatrix(matrix());
  assert.equal(result.passed, true);
  assert.equal(result.cells[0].normalizedSsim, 0.97);
});

test("rejects incomplete, duplicate, unknown and unsupported matrices", () => {
  for (const value of [undefined, {}, { schemaVersion: 1, cells: matrix().cells },
    { schemaVersion: 2, cells: [] }, { schemaVersion: 2, cells: [cell("on")] },
    { schemaVersion: 2, cells: [cell("on"), cell("on")] },
    { schemaVersion: 2, cells: [cell("on"), cell("other")] },
    { schemaVersion: 2, cells: [...matrix().cells, cell("off")] },
    { schemaVersion: 2, cells: [null, cell("off")] }]) {
    assert.equal(evaluateGiClosureMatrix(value).passed, false);
  }
});

test("raw metrics cannot stand in for missing normalized or edge evidence", () => {
  for (const field of ["exposureNormalized", "edgeBand"]) {
    const value = matrix();
    value.cells[0].metrics = { ssim: 1, meanAbsoluteError: 0, normalizedSsim: 1, normalizedMae: 0 };
    delete value.cells[0][field];
    assert.equal(evaluateGiClosureMatrix(value).passed, false);
  }
});

for (const [group, field, failure] of [["exposureNormalized", "normalizedSsim", 0.969],
  ["exposureNormalized", "normalizedMae", 0.031], ["edgeBand", "f1", 0.899]]) {
  test(`rejects failing or invalid ${field} on either cell`, () => {
    for (const index of [0, 1]) for (const bad of [failure, undefined, null, "1", NaN, Infinity, -0.1, 1.1]) {
      const value = matrix();
      value.cells[index][group][field] = bad;
      assert.equal(evaluateGiClosureMatrix(value).passed, false);
    }
  });
}

test("evidence-supplied thresholds cannot relax the closure gate", () => {
  const value = matrix();
  value.thresholds = { normalizedSsimMin: 0, normalizedMaeMax: 1, edgeBandF1Min: 0 };
  value.cells[1].edgeBand.f1 = 0.601129;
  assert.equal(evaluateGiClosureMatrix(value).passed, false);
});
