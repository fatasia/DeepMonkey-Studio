import test from "node:test";
import assert from "node:assert/strict";
import { baselineOf, deltaE2000, deltaE76, evaluateParityRun, measureFrame, metricsTier, regressionViolations, srgbBytesToLab } from "./parityGateMetrics.mjs";

const frame = (width, height, fill) => { const data = new Uint8Array(width * height * 4); for (let i = 0; i < width * height; i++) data.set([...fill(i), 255], i * 4); return data; };

test("CIEDE2000 matches the Sharma reference pairs", () => {
  const pairs = [[[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425], [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, -1, 2], [50, 0, 0], 2.3669], [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644], [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373]];
  for (const [a, b, expected] of pairs) assert.ok(Math.abs(deltaE2000(a, b) - expected) < 1e-3, `${a} vs ${b}`);
  assert.equal(deltaE2000([50, 10, 10], [50, 10, 10]), 0);
});

test("sRGB white/black map to Lab anchors and ΔE76 is Euclidean", () => {
  const white = srgbBytesToLab(255, 255, 255), black = srgbBytesToLab(0, 0, 0);
  assert.ok(Math.abs(white[0] - 100) < 1e-2 && Math.abs(white[1]) < 1e-2 && Math.abs(white[2]) < 1e-2);
  assert.deepEqual(black.map(Math.abs), [0, 0, 0]);
  assert.ok(Math.abs(deltaE76(white, black) - 100) < 1e-2);
});

test("identical frames are strict and a global offset lowers the tier", () => {
  const a = frame(32, 24, i => [i % 256, 40, 200]), same = measureFrame({ width: 32, height: 24, three: a, deep: a });
  assert.equal(same.rmse, 0); assert.equal(same.byteMax, 0); assert.equal(same.deltaE2000.max, 0); assert.ok(same.ssim.mean > .999999); assert.equal(metricsTier(same), "strict");
  const shifted = measureFrame({ width: 32, height: 24, three: a, deep: frame(32, 24, i => [Math.min(255, i % 256 + 24), 64, 200]) });
  assert.ok(shifted.rmse > 6 && shifted.byteMax >= 24 && shifted.lumaBias > 0); assert.equal(metricsTier(shifted), "diagnostic");
});

test("an empty frame on both sides has zero coverage so the evaluator can reject it", () => {
  const black = frame(16, 12, () => [0, 0, 0]), metrics = measureFrame({ width: 16, height: 12, three: black, deep: black });
  assert.equal(metrics.coverage, 0);
  const [verdict] = evaluateParityRun([{ id: "x", metrics }], { x: { expectedTier: "strict", minCoverage: 10, baseline: baselineOf(metrics) } });
  assert.equal(verdict.passed, false); assert.match(verdict.failures[0], /coverage/);
});

test("regression guard blocks a worse known gap and ratchet notes an improvement", () => {
  const worse = frame(32, 24, i => [i % 256, 40, 200]), reference = frame(32, 24, i => [Math.min(255, i % 256 + 12), 40, 200]);
  const baseline = baselineOf(measureFrame({ width: 32, height: 24, three: worse, deep: reference }));
  const degraded = measureFrame({ width: 32, height: 24, three: worse, deep: frame(32, 24, i => [Math.min(255, i % 256 + 40), 40, 200]) });
  assert.ok(regressionViolations(degraded, baseline).some(item => item.name === "rmse"));
  const [verdict] = evaluateParityRun([{ id: "gap", metrics: degraded }], { gap: { expectedTier: "diagnostic", minCoverage: 1, baseline } });
  assert.equal(verdict.passed, false);
  const exact = measureFrame({ width: 32, height: 24, three: worse, deep: worse });
  const [better] = evaluateParityRun([{ id: "gap", metrics: exact }], { gap: { expectedTier: "diagnostic", minCoverage: 1, baseline } });
  assert.equal(better.passed, true); assert.match(better.ratchet, /raise expectedTier/);
});

test("scenario-set drift is a hard error", () => {
  assert.throws(() => evaluateParityRun([], { a: { expectedTier: "strict", minCoverage: 1, baseline: {} } }), /scenario set mismatch/);
});
