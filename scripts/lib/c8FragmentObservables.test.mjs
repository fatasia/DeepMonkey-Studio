import { test } from "node:test";
import assert from "node:assert/strict";
import { compareFragmentObservables } from "./c8FragmentObservables.mjs";
const h = "a".repeat(64), modified = "b".repeat(64);
function fixture() {
  const captures = [];
  for (const view of ["near", "far"]) {
    const capture = { view };
    for (const mode of ["geometry", "single"]) {
      const receipt = { mode, deep: { originalHash: h, instrumentedHash: mode === "geometry" ? modified : "c".repeat(64), moduleCount: 1 }, three: { originalChunkHash: h, instrumentedChunkHash: mode === "geometry" ? modified : "c".repeat(64), installCount: 1, actualCompiledFragmentHashes: [modified], compileObservations: 1 } };
      const frames = [0, 1].map(camera => {
        const hdr = Array(320 * 192 * 3).fill(0);
        for (let y = 50; y < 140; y++) for (let x = 50; x < 270; x++) {
          const p = (y * 320 + x) * 3; hdr[p] = .7; hdr[p + 1] = .5; hdr[p + 2] = mode === "geometry" ? x < 160 ? .2 : .9 : .3;
        }
        const leg = { hdr, hdrFormat: "rgba16float", rootHash: h, profileHash: h, drawCalls: 2, triangles: 2196 };
        return { stage: "direct-diagnostic", camera, rootHash: h, profileHash: h, packetHash: h, three: structuredClone(leg), deep: structuredClone(leg) };
      });
      const scale = view === "near" ? .6 : 1;
      capture[mode] = { receipt, run: { width: 320, height: 192, frames, errors: [], profile: { exposures: [.5], directProfile: "three-r185", hdrAttachmentProfile: "shared-rgba16f", cameras: [[0, 0, 9], [3, 2, 9]].map(eye => ({ eye: eye.map(value => value * scale) })) } } };
    }
    captures.push(capture);
  }
  return captures;
}
test("complete actual observation does not certify the unchanged quality gate", () => {
  const result = compareFragmentObservables(fixture()); assert(result.passed); assert(!result.qualityCertified); assert.equal(result.rows.length, 4);
});
for (const [name, mutate] of [
  ["empty module receipt", data => { data[0].geometry.receipt.deep.moduleCount = 0; }],
  ["missing compiled Three", data => { data[0].single.receipt.three.actualCompiledFragmentHashes = []; }],
  ["stale reused mode", data => { data[0].single.receipt.mode = "geometry"; }],
  ["source changed", data => { data[1].single.receipt.deep.originalHash = "d".repeat(64); }],
  ["packet changed", data => { data[0].single.run.frames[0].packetHash = modified; }],
  ["nonfinite actual data", data => { data[0].geometry.run.frames[0].deep.hdr[0] = Infinity; }],
  ["all black geometry", data => { data[0].geometry.run.frames[0].deep.hdr.fill(0); }],
  ["single response absent", data => { data[0].single.run.frames[0].deep.hdr.fill(0); }],
  ["material diagnostic substituted", data => { data[0].single.run.profile.directProfile = "single-scatter"; }],
  ["camera silently reused", data => { data[0].single.run.profile.cameras[1].eye = [0, 0, 5.4]; }],
]) test(`rejects ${name}`, () => { const data = fixture(); mutate(data); assert.throws(() => compareFragmentObservables(data)); });
