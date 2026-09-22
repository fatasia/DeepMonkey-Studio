import test from "node:test";
import assert from "node:assert/strict";
import { readAndValidateMatrix, validateStageMatrix } from "./industrial-stage-matrix.mjs";

test("S1–S6 matrix is structurally valid and keeps all profiles non-production", async () => {
  const result = await readAndValidateMatrix();
  assert.equal(result.matrix.stages.length, 6);
  assert.equal(result.matrix.profiles.length, 7);
  assert.equal(result.matrix.terminology.parasolidDisplayName, "X_T");
  assert.equal(result.matrix.terminology.parasolidExtension, ".x_t");
  assert.ok(/^[a-f0-9]{64}$/.test(result.sha256));
});

test("matrix rejects production promotion of an unsupported X_T profile", async () => {
  const { matrix } = await readAndValidateMatrix();
  const altered = structuredClone(matrix);
  altered.profiles.find(profile => profile.id === "bim.xt-builtin").quality = "visual-complete";
  assert.throws(() => validateStageMatrix(altered), /X_T profile/);
});

test("matrix rejects the legacy user-visible Parasolid spelling", async () => {
  const { matrix } = await readAndValidateMatrix();
  const altered = structuredClone(matrix);
  altered.stages[0].summary = "XT is ready";
  assert.throws(() => validateStageMatrix(altered), /禁止的用户可见 XT/);
});

test("matrix requires explicit gates for every non-complete stage", async () => {
  const { matrix } = await readAndValidateMatrix();
  const altered = structuredClone(matrix);
  altered.stages[0].openGates = [];
  assert.throws(() => validateStageMatrix(altered), /openGates/);
  altered.stages[0].status = "complete";
  altered.stages[0].openGates = ["stale gate"];
  assert.throws(() => validateStageMatrix(altered), /complete/);
});
