import assert from "node:assert/strict";
import test from "node:test";
import { evaluateIndustrialStageDelta } from "./industrialStageDeltaEvidence.mjs";

test("accepts exactly S1–S6 and ignores S0 history rows", () => {
  const value = evaluateIndustrialStageDelta("| S0 | old |\n| S1 | a |\n| S2 | b |\n| S3 | c |\n| S4 | d |\n| S5 | e |\n| S6 | f |");
  assert.deepEqual(value.stages, ["S1", "S2", "S3", "S4", "S5", "S6"]);
  assert.equal(value.completeStageMatrix, true);
});

test("rejects duplicate or out-of-range stage rows", () => {
  assert.equal(evaluateIndustrialStageDelta("| S0 | old |\n| S1 | a |\n| S1 | duplicate |").completeStageMatrix, false);
  assert.equal(evaluateIndustrialStageDelta("| S1 | a |\n| S2 | b |\n| S3 | c |\n| S4 | d |\n| S5 | e |").completeStageMatrix, false);
});
