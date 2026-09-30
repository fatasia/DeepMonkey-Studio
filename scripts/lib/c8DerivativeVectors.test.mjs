import { test } from "node:test";
import assert from "node:assert/strict";
import { compareDerivativeVectors } from "./c8DerivativeVectors.mjs";
const H = s => s.repeat(64);
function fixture() {
  const n = new Array(320 * 192 * 3), dx = new Array(n.length), dy = new Array(n.length);
  for (let y = 0; y < 192; y++) for (let x = 0; x < 320; x++) { const v = [x / 200 - .8, y / 200 - .48, 1], length = Math.hypot(...v); for (let k = 0; k < 3; k++) n[(y * 320 + x) * 3 + k] = v[k] / length * .5 + .5; }
  for (let y = 0; y < 192; y += 2) for (let x = 0; x < 320; x += 2) for (const p of [y * 320 + x, y * 320 + x + 1, (y + 1) * 320 + x, (y + 1) * 320 + x + 1]) for (let k = 0; k < 3; k++) {
    const anchor = (y * 320 + x) * 3 + k; dx[p * 3 + k] = Math.abs(n[anchor + 3] - n[anchor]) * 2; dy[p * 3 + k] = Math.abs(n[anchor + 320 * 3] - n[anchor]) * 2;
  }
  return ["view-normal", "abs-dx", "abs-dy"].map((mode, i) => ({ mode, receipt: { mode, derivative: "default", threeDerivative: "default",
    deep: { moduleCount: 1, originalHash: H("a"), instrumentedHash: H(String(i + 1)) }, three: { installCount: 1, originalChunkHash: H("b"), instrumentedChunkHash: H(String(i + 4)), actualCompiledFragmentHashes: [H("f")], compileObservations: 1 } },
    run: { width: 320, height: 192, errors: [], profile: { exposures: [.5], directProfile: "three-r185", hdrAttachmentProfile: "shared-rgba16f", cameras: [{ eye: [0, 0, 9] }, { eye: [3, 2, 9] }] },
      frames: [0, 1].map(camera => { const leg = { hdr: [n, dx, dy][i], rootHash: H("c"), profileHash: H("d"), drawCalls: 6, triangles: 2196, hdrFormat: "rgba16float" }; return { camera, stage: "direct-diagnostic", rootHash: H("c"), profileHash: H("d"), packetHash: H("e"), three: { ...leg }, deep: { ...leg } }; }) } }));
}
test("normal local differences explain observed operators while final quality remains separate", () => { const result = compareDerivativeVectors(fixture()); assert.equal(result.qualityCertified, false); assert(result.rows.every(row => row.classification === "compatible with normal local derivative differences")); });
test("valid but changed normals remain unexplained instead of certifying alignment", () => { const c = fixture(); c[0].run.frames[0].deep.hdr = c[0].run.frames[0].deep.hdr.map((v, i, a) => i % 3 === 0 ? a[i + 2] : i % 3 === 2 ? a[i - 2] : v); assert.equal(compareDerivativeVectors(c).rows[0].classification, "unexplained derivative residue"); });
for (const [name, mutate] of [
  ["missing dy matrix", c => c.pop()],
  ["fine mixed into default", c => { c[0].receipt.derivative = "fine"; }],
  ["empty actual shader receipt", c => { c[0].receipt.deep.moduleCount = 0; }],
  ["missing GL compilation", c => { c[0].receipt.three.actualCompiledFragmentHashes = []; }],
  ["reused observed module", c => { c[0].receipt.deep.instrumentedHash = c[1].receipt.deep.instrumentedHash; }],
  ["changed packet", c => { c[1].run.frames[0].packetHash = H("f"); }],
  ["empty normal geometry", c => { c[0].run.frames[0].deep.hdr = new Array(320 * 192 * 3).fill(0); }],
  ["non-unit encoded normal", c => { c[0].run.frames[0].deep.hdr = new Array(320 * 192 * 3).fill(.6); }],
  ["zero derivative signal", c => { c[1].run.frames[0].deep.hdr = new Array(320 * 192 * 3).fill(0); }],
  ["nonfinite vector", c => { c[2].run.frames[0].deep.hdr = [...c[2].run.frames[0].deep.hdr]; c[2].run.frames[0].deep.hdr[3] = Infinity; }],
]) test(`rejects ${name}`, () => { const c = fixture(); mutate(c); assert.throws(() => compareDerivativeVectors(c)); });
