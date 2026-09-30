import { test } from "node:test";
import assert from "node:assert/strict";
import { compareDerivativeAblation } from "./c8DerivativeAblation.mjs";
const H = c => c.repeat(64);
function fixture() {
  const hdr = Array.from({ length: 320 * 192 * 3 }, (_, i) => i % 3 === 0 ? (Math.floor(i / 3) % 3 === 0 ? .15 : .9) : .1);
  return ["fine", "coarse"].map((derivative, index) => ({ derivative, receipt: { mode: "rough-single", derivative, threeDerivative: "default",
    deep: { moduleCount: 1, originalHash: H("a"), instrumentedHash: H(index ? "b" : "c") }, three: { installCount: 1, originalChunkHash: H("d"), instrumentedChunkHash: H("e"), actualCompiledFragmentHashes: [H("f")], compileObservations: 1 } },
    run: { width: 320, height: 192, errors: [], profile: { exposures: [.5], directProfile: "three-r185", hdrAttachmentProfile: "shared-rgba16f", cameras: [{ eye: [0, 0, 9] }, { eye: [3, 2, 9] }] },
      frames: [0, 1].map(camera => { const leg = { rootHash: H("a"), profileHash: H("b"), hdrFormat: "rgba16float", hdr, drawCalls: 6, triangles: 1001 }; return { camera, stage: "direct-diagnostic", rootHash: H("a"), profileHash: H("b"), packetHash: H("c"), three: { ...leg }, deep: { ...leg } }; }) } }));
}
test("complete observations do not certify final quality", () => { assert.equal(compareDerivativeAblation(fixture()).qualityCertified, false); });
for (const [name, mutate] of [
  ["missing candidate", c => c.pop()],
  ["wrong Three derivative claim", c => { c[0].receipt.threeDerivative = "fine"; }],
  ["empty actual GL compile", c => { c[0].receipt.three.actualCompiledFragmentHashes = []; }],
  ["reused candidate module", c => { c[0].receipt.deep.instrumentedHash = c[1].receipt.deep.instrumentedHash; }],
  ["reused camera", c => { c[0].run.frames[1].camera = 0; }],
  ["changed packet", c => { c[0].run.frames[0].packetHash = H("e"); }],
  ["nonfinite attachment", c => { c[0].run.frames[0].deep.hdr = [...c[0].run.frames[0].deep.hdr]; c[0].run.frames[0].deep.hdr[4] = NaN; }],
  ["absent single response", c => { c[0].run.frames[0].deep.hdr = c[0].run.frames[0].deep.hdr.map((v, i) => i % 3 ? 0 : v); }],
  ["constant roughness", c => { c[0].run.frames[0].deep.hdr = c[0].run.frames[0].deep.hdr.map((v, i) => i % 3 ? v : .5); }],
]) test(`rejects ${name}`, () => { const captures = fixture(); mutate(captures); assert.throws(() => compareDerivativeAblation(captures)); });
