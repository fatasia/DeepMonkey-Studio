import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareDisplayFrames, compareDisplayLibraries } from "./lib/j3DisplayParity.mjs";

const fixture = JSON.parse(readFileSync(new URL("../packages/deep-engine/fixtures/display-parity-v1.json", import.meta.url), "utf8"));
const pixelCount = fixture.width * fixture.height;

function bytes(rgb = [40, 80, 160]) {
  const output = new Array(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) output.splice(i * 4, 4, ...rgb, 255);
  return output;
}

function floats(rgb = [0.125, 0.25, 0.5]) {
  const output = new Array(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) output.splice(i * 4, 4, ...rgb, 1);
  return output;
}

test("Gate D accepts identical valid output and one registered quantization step", () => {
  const a = bytes(), b = [...a];
  const same = compareDisplayFrames(a, b, fixture);
  assert.equal(same.passed, true);
  assert.equal(same.maxByteError, 0);
  assert.equal(same.ssim.min, 1);
  assert.equal(same.psnr, "infinity");
  b[2] += 1;
  const quantized = compareDisplayFrames(a, b, fixture);
  assert.equal(quantized.maxByteError, 1);
  assert.equal(quantized.passed, true);
});

test("Gate D rejects a dropped row, mismatched legs and declared dimension drift", () => {
  const a = bytes();
  assert.throws(() => compareDisplayFrames(a.slice(0, -fixture.width * 4), a, fixture), /dimensions differ/);
  assert.throws(() => compareDisplayFrames(a, a.slice(0, -4), fixture), /dimensions differ/);
  assert.throws(() => compareDisplayFrames(a, a, { ...fixture, height: fixture.height + 1 }), /dimensions differ/);
});

test("Gate D rejects matching black frames and a black leg despite perfect self SSIM", () => {
  const black = bytes([0, 0, 0]);
  const both = compareDisplayFrames(black, black, fixture);
  assert.equal(both.ssim.min, 1);
  assert.equal(both.maxByteError, 0);
  assert.equal(both.passed, false);
  assert.equal(compareDisplayFrames(bytes(), black, fixture).passed, false);
});

test("Gate D requires more than half of pixels to be non-black in both legs", () => {
  const a = bytes([0, 0, 0]);
  for (let i = 0; i < pixelCount / 2; i++) a[i * 4] = 80;
  assert.equal(compareDisplayFrames(a, a, fixture).passed, false);
  a[(pixelCount / 2) * 4] = 80;
  assert.equal(compareDisplayFrames(a, a, fixture).passed, true);
});

test("Gate D catches a single-channel tint that a luma-only SSIM gate would accept", () => {
  const a = bytes(), b = [...a];
  for (let i = 0; i < pixelCount; i++) b[i * 4 + 2] += 18;
  const result = compareDisplayFrames(a, b, fixture);
  assert.ok(result.ssim.min >= fixture.thresholds.outputMinSsim, "blue tint stays inside the luma tolerance");
  assert.equal(result.maxByteError, 18);
  assert.equal(result.passed, false);
});

test("Gate D compares alpha even when RGB is identical", () => {
  const a = bytes(), b = [...a];
  b[3] = 251;
  const result = compareDisplayFrames(a, b, fixture);
  assert.equal(result.ssim.min, 1);
  assert.equal(result.maxByteError, 4);
  assert.equal(result.passed, false);
});

test("Gate D rejects a local low-light difference within the byte tolerance", () => {
  const a = bytes([3, 3, 3]), b = [...a];
  for (let y = 0; y < fixture.height / 8; y++) {
    for (let x = 0; x < fixture.width / 8; x++) {
      const offset = (y * fixture.width + x) * 4;
      b[offset] = b[offset + 1] = b[offset + 2] = 4;
    }
  }
  const result = compareDisplayFrames(a, b, fixture);
  assert.equal(result.maxByteError, 1);
  assert.ok(result.ssim.mean > fixture.thresholds.outputMinSsim, "global average hides the local defect");
  assert.ok(result.ssim.min < fixture.thresholds.outputMinSsim);
  assert.equal(result.passed, false);
});

test("Gate D rejects malformed bytes in either leg before comparing", () => {
  for (const bad of [NaN, Infinity, -Infinity, -1, 256, 0.5, undefined]) {
    const a = bytes(), b = [...a];
    b[5] = bad;
    assert.throws(() => compareDisplayFrames(a, b, fixture), /Invalid output byte/);
    assert.throws(() => compareDisplayFrames(b, a, fixture), /Invalid output byte/);
  }
});

test("C8 accepts valid identical libraries and honors the exact absolute tolerance", () => {
  const a = floats(), b = [...a];
  a[0] = b[0] = 0;
  assert.equal(compareDisplayLibraries(a, b, fixture).passed, true);
  b[0] = fixture.thresholds.libraryMaxFloatError;
  assert.equal(compareDisplayLibraries(a, b, fixture).passed, true);
  b[0] *= 1.01;
  assert.equal(compareDisplayLibraries(a, b, fixture).passed, false);
});

test("C8 rejects truncated / inconsistent library targets and dimension drift", () => {
  const a = floats();
  assert.throws(() => compareDisplayLibraries(a.slice(0, -4), a, fixture), /dimensions differ/);
  assert.throws(() => compareDisplayLibraries(a, a.slice(0, -4), fixture), /dimensions differ/);
  assert.throws(() => compareDisplayLibraries(a, a, { ...fixture, width: fixture.width + 1 }), /dimensions differ/);
});

test("C8 rejects non-finite output in either leg, including mutually identical infinities", () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    const a = floats(), b = [...a];
    b[6] = bad;
    assert.throws(() => compareDisplayLibraries(a, b, fixture), /Non-finite/);
    assert.throws(() => compareDisplayLibraries(b, a, fixture), /Non-finite/);
    assert.throws(() => compareDisplayLibraries(b, b, fixture), /Non-finite/);
  }
});

test("C8 rejects matching all-black libraries with opaque alpha", () => {
  const black = floats([0, 0, 0]);
  assert.equal(compareDisplayLibraries(black, black, fixture).passed, false);
});

test("C8 catches one-channel float drift and alpha drift without averaging them away", () => {
  for (const channel of [2, 3]) {
    const a = floats(), b = [...a];
    b[channel] += fixture.thresholds.libraryMaxFloatError * 2;
    const result = compareDisplayLibraries(a, b, fixture);
    assert.ok(result.maxFloatError > fixture.thresholds.libraryMaxFloatError);
    assert.equal(result.passed, false);
  }
});
