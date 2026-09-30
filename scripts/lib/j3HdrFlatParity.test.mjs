import test from "node:test";
import assert from "node:assert/strict";
import { compareHdrFlat } from "./j3HdrFlatParity.mjs";
const pixels = Array.from({ length: 16 }, (_, i) => (8 + Math.floor(i / 4)) * 24 + 8 + i % 4);
const manifest = { width: 24, height: 24, packageHash: "p", packetHash: "r",
  cameras: [{ id: "axis", expectedVP: Array(16).fill(0), subsets: [{ instanceId: "fixed-triangle", pixels, diffuseFloor: [.00005, .00005, .00005] }] }],
  sun: { surfaceToLightWorld: [0, .6, .8], radiance: [2.5, 2.4, 2.25], intensity: 1, exposure: 1 },
  thresholds: { vpMaxError: 2e-5, depthMaxError: 2e-6, planeMaxError: 2e-6, minStablePixels: 64, edgeRadius: 1 },
  hdrThresholds: { minPixelsPerSubset: 16, maxChannelError: .002, minPsnr: 60, minSsim: .9999, peak: 1 } };
function leg(native = false) {
  const samples = native ? 4 : 1, depth = Array.from({ length: 24 * 24 * samples }, (_, i) => {
    const p = Math.floor(i / samples), x = p % 24, y = Math.floor(p / 24);
    return x >= 4 && x < 20 && y >= 4 && y < 20 ? .5 : 1;
  });
  const lighting = { direction: [0, .6, .8], radiance: [2.5, 2.4, 2.25], exposure: 1, environment: 0, shadows: 0,
    ...(native ? { authoredMode: 2, localLights: 0 } : { intensity: 1, diffuseCoefficients: Array(16).fill(0) }) };
  const frames = [0, 1].map(round => ({ cameraId: "axis", round, depth: [...depth], depthSamples: samples,
    vp: Array(16).fill(0), hdrNonBackground: 256, hdr: Array(24 * 24 * 3).fill(.1), lighting: structuredClone(lighting), localLightCount: 0 }));
  return { ...manifest, frames, defaults: [structuredClone(frames[0])], passed: true, profile: "same-authored-sun", sourceHash: "a".repeat(64) };
}
test("frozen production subset exact RGB passes independently of diagnostic difference", () => {
  const native = leg(true); native.defaults[0].hdr.fill(.5);
  const result = compareHdrFlat(manifest, leg(), native);
  assert.equal(result.passed, true); assert.equal(result.cases[0].rounds[0].exact, true);
  assert.equal(result.diagnostics[0].default.maxError, .4);
});
test("HDR+0.01 at a preregistered pixel fails without color-based exclusion", () => {
  const native = leg(true); native.frames.forEach(f => { f.hdr[pixels[0] * 3] += .01; });
  assert.throws(() => compareHdrFlat(manifest, leg(), native), /Strict flat-normal HDR/);
});
test("PSNR rejects a systematic shift below the maximum-channel threshold", () => {
  const native = leg(true); native.frames.forEach(f => f.hdr.fill(.1012));
  assert.throws(() => compareHdrFlat(manifest, leg(), native), /Strict flat-normal HDR/);
});
test("SSIM rejects near-black structure drift even when PSNR and maximum error pass", () => {
  const web = leg(), native = leg(true);
  web.frames.forEach(f => f.hdr.fill(.0001)); native.frames.forEach(f => f.hdr.fill(.001));
  assert.throws(() => compareHdrFlat(manifest, web, native), /Strict flat-normal HDR/);
});
test("both hosts returning black with correct uniforms cannot pass mutual agreement", () => {
  const web = leg(), native = leg(true);
  for (const host of [web, native]) host.frames.forEach(f => f.hdr.fill(0));
  assert.throws(() => compareHdrFlat(manifest, web, native), /CPU direct-Lambert/);
});
test("both hosts ignoring the requested sun fails mutual agreement", () => {
  const web = leg(), native = leg(true);
  for (const host of [web, native]) host.frames.forEach(f => { f.lighting.radiance = [0, 0, 0]; });
  assert.throws(() => compareHdrFlat(manifest, web, native), /lighting uniforms/);
});
test("hidden extra diffuse/local light and false author mode fail", () => {
  const diffuse = leg(); diffuse.frames.forEach(f => { f.lighting.diffuseCoefficients[0] = .1; });
  assert.throws(() => compareHdrFlat(manifest, diffuse, leg(true)), /lighting uniforms/);
  const native = leg(true); native.frames.forEach(f => { f.lighting.authoredMode = 0; });
  assert.throws(() => compareHdrFlat(manifest, leg(), native), /lighting uniforms/);
});
test("missing geometry/layout/finite RGB and repeat instability fail", () => {
  const missing = leg(true); missing.frames.forEach(f => f.depth.fill(1, pixels[0] * 4, pixels[0] * 4 + 4));
  assert.throws(() => compareHdrFlat(manifest, leg(), missing), /geometry|coverage/);
  const invalid = leg(true); invalid.frames[0].hdr[0] = NaN;
  assert.throws(() => compareHdrFlat(manifest, leg(), invalid), /HDR layout/);
  const unstable = leg(true); unstable.frames[1].hdr[0] += .01;
  assert.throws(() => compareHdrFlat(manifest, leg(), unstable), /HDR\/lighting drift/);
});
