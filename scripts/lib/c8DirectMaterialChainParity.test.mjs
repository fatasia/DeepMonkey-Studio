import { test } from "node:test";
import assert from "node:assert/strict";
import { compareDirectMaterialChain } from "./c8DirectMaterialChainParity.mjs";
function fixture() {
  const width = 64, height = 48, identity = "a".repeat(64), frames = [];
  for (const stage of ["strict-emissive", "direct-diagnostic"]) for (const camera of [0, 1]) {
    const hdr = Array(width * height * 3).fill(0), display = Array(width * height * 4).fill(0);
    for (let y = 4; y < height - 4; y++) for (let x = 4; x < width - 4; x++) {
      const pixel = y * width + x; hdr.fill(stage === "strict-emissive" ? .2 : .4, pixel * 3, pixel * 3 + 3); display.fill(100, pixel * 4, pixel * 4 + 4);
    }
    const leg = { hdr, display, rootHash: identity, profileHash: identity, drawCalls: 6, triangles: 2000 };
    frames.push({ name: `${stage}/${camera}`, stage, camera, exposure: .5, rootHash: identity, profileHash: identity, packetHash: identity, three: structuredClone(leg), deep: structuredClone(leg) });
  }
  return { width, height, frames, errors: [], profile: { directProfile: "three-r185", exposures: [.5] } };
}
test("original Three r185 final direct output must meet the strict gate", () => assert(compareDirectMaterialChain(fixture(), "three-r185").finalDirectStrict));
test("final direct HDR drift fails although diagnostic-only S4 admits it", () => {
  const run = fixture(); run.frames[2].deep.hdr[20 * run.width * 3 + 60] += .003;
  assert.throws(() => compareDirectMaterialChain(run, "three-r185"), /full direct HDR/);
  run.profile.directProfile = "single-scatter"; assert(compareDirectMaterialChain(run, "single-scatter").passed);
});
test("final display drift and mismatched actual profile cannot pass", () => {
  const run = fixture(); run.frames[2].deep.display[20 * run.width * 4 + 80] += 3;
  assert.throws(() => compareDirectMaterialChain(run, "three-r185"), /surface/);
  assert.throws(() => compareDirectMaterialChain(run, "single-scatter"), /actual shader/);
});
test("lowering Three to the Deep single-scatter diagnostic is never a quality repair", () => {
  const run = fixture(); run.profile.directProfile = "deep-single-scatter";
  const result = compareDirectMaterialChain(run, "deep-single-scatter"); assert(result.diagnosticOnly); assert(!result.finalDirectStrict);
});
test("explicit shared half-float profile requires both actual attachment identities", () => {
  const run = fixture(); run.profile.hdrAttachmentProfile = "shared-rgba16f";
  assert.throws(() => compareDirectMaterialChain(run, "three-r185"), /actual HDR attachment/);
  for (const frame of run.frames) frame.three.hdrFormat = frame.deep.hdrFormat = "rgba16float";
  assert.equal(compareDirectMaterialChain(run, "three-r185").hdrAttachmentProfile, "shared-rgba16f");
  run.profile.hdrAttachmentProfile = "unknown";
  assert.throws(() => compareDirectMaterialChain(run, "three-r185"), /unknown HDR/);
  run.profile.hdrAttachmentProfile = undefined;
  assert.throws(() => compareDirectMaterialChain(run, "three-r185"), /unknown HDR/);
});
