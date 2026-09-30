import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { validateProbeGiSourceReceipt } from "./j2ProbeGiSourceReceipt.mjs";
const hash = value => createHash("sha256").update(value).digest("hex");
test("GI compute receipt rejects changed compiled code and every direct source input", () => {
  const inputs = { wrapper: "wrapper", kernel: "shared kernel", adapter: "Rust adapter" };
  const source = "fn deepGiSampleLevelData( fn nativeGiLoadRecord( fn probeMain()";
  const receipt = { source, sourceHash: hash(source), sourceInputHashes: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, hash(value)])) };
  assert.equal(validateProbeGiSourceReceipt(receipt, inputs), source);
  assert.throws(() => validateProbeGiSourceReceipt({ ...receipt, source: source + "changed" }, inputs));
  for (const key of Object.keys(inputs)) assert.throws(() => validateProbeGiSourceReceipt(receipt, { ...inputs, [key]: "changed" }));
  assert.throws(() => validateProbeGiSourceReceipt({ ...receipt, source: "fn probeMain()", sourceHash: hash("fn probeMain()") }, inputs));
});
