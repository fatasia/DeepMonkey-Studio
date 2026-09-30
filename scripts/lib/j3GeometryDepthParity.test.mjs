import test from "node:test";
import assert from "node:assert/strict";
import { compareGeometryDepth } from "./j3GeometryDepthParity.mjs";
const manifest = { width: 24, height: 24, packageHash: "p", packetHash: "r", cameras: [{ id: "axis", expectedVP: Array(16).fill(0) }],
  thresholds: { vpMaxError: 2e-5, depthMaxError: 2e-6, planeMaxError: 2e-6, minStablePixels: 64, edgeRadius: 1 } };
function leg(samples = 1) {
  const depth = Array.from({ length: 24 * 24 * samples }, (_, i) => {
    const pixel = Math.floor(i / samples), x = pixel % 24, y = Math.floor(pixel / 24);
    return x >= 4 && x < 20 && y >= 4 && y < 20 ? .5 : 1;
  });
  return { ...manifest, passed: true, frames: [0, 1].map(round => ({ cameraId: "axis", round,
    depth: [...depth], depthSamples: samples, vp: Array(16).fill(0), hdrNonBackground: 256 })) };
}
test("actual layout contract compares stable interior with explicit MSAA scope", () => {
  const result = compareGeometryDepth(manifest, leg(), leg(4));
  assert.equal(result.passed, true); assert.equal(result.cases[0].rounds[0].stablePixels, 196);
});
test("identity/camera drift and empty geometry fail", () => {
  const mismatch = leg(4); mismatch.packetHash = "wrong";
  assert.throws(() => compareGeometryDepth(manifest, leg(), mismatch), /manifest/);
  const camera = leg(4); camera.frames.forEach(frame => { frame.vp[0] = .1; });
  assert.throws(() => compareGeometryDepth(manifest, leg(), camera), /camera VP/);
  const empty = leg(4); empty.frames.forEach(frame => { frame.depth.fill(1); });
  assert.throws(() => compareGeometryDepth(manifest, leg(), empty), /geometry depth/);
});
test("depth+1e-3 negative control is not discarded by planar selection", () => {
  const native = leg(4); native.frames.forEach(frame => { frame.depth = frame.depth.map(value => value < 1 ? value + .001 : value); });
  assert.throws(() => compareGeometryDepth(manifest, leg(), native), /interior depth drift/);
});
test("both hosts ignoring the requested camera cannot pass mutual agreement", () => {
  const web = leg(), native = leg(4);
  for (const host of [web, native]) host.frames.forEach(frame => { frame.vp[0] = .1; });
  assert.throws(() => compareGeometryDepth(manifest, web, native), /manifest reference/);
});
test("a shared 1px MSAA halo is allowed but a 2px extent is rejected", () => {
  const native = leg(4);
  native.frames.forEach(frame => { for (let y = 4; y < 20; y++) frame.depth[(y * 24 + 3) * 4] = .5; });
  assert.equal(compareGeometryDepth(manifest, leg(), native).passed, true);
  native.frames.forEach(frame => { for (let y = 4; y < 20; y++) frame.depth[(y * 24 + 2) * 4] = .5; });
  assert.throws(() => compareGeometryDepth(manifest, leg(), native), /coverage drift/);
});
test("an actual missing interior patch cannot wash out through edge exclusion", () => {
  const native = leg(4); native.frames.forEach(frame => {
    for (let y = 9; y < 15; y++) for (let x = 9; x < 15; x++) frame.depth.fill(1, (y * 24 + x) * 4, (y * 24 + x + 1) * 4);
  });
  assert.throws(() => compareGeometryDepth(manifest, leg(), native), /coverage drift/);
});
test("invalid values/layout and repeated instability fail", () => {
  const invalid = leg(4); invalid.frames[0].depth[0] = NaN;
  assert.throws(() => compareGeometryDepth(manifest, leg(), invalid), /drift|values/);
  assert.throws(() => compareGeometryDepth(manifest, leg(), leg(1)), /layout/);
  const unstable = leg(4); unstable.frames[1].depth[100] = .1;
  assert.throws(() => compareGeometryDepth(manifest, leg(), unstable), /Repeated/);
});
