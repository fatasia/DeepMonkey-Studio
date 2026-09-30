import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const hash = text => createHash("sha256").update(text).digest("hex");

export function validateProbeGiSourceReceipt(receipt, inputs) {
  assert.equal(typeof receipt.source, "string", "Native compute source receipt required");
  assert.equal(hash(receipt.source), receipt.sourceHash, "compiled compute source hash");
  for (const key of ["wrapper", "kernel", "adapter"]) {
    assert.equal(receipt.sourceInputHashes?.[key], hash(inputs[key]), `Native compute ${key} input drifted`);
  }
  assert(receipt.source.includes("fn deepGiSampleLevelData("), "canonical provider required");
  assert(receipt.source.includes("fn nativeGiLoadRecord("), "Native record adapter required");
  assert(receipt.source.includes("fn probeMain()"), "actual compute entry required");
  return receipt.source;
}
