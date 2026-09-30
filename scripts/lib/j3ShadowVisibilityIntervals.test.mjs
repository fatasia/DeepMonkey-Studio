import test from "node:test";
import assert from "node:assert/strict";
import { halfFloatInterval, intersectShadowVisibility, shadowVisibilityInterval } from "./j3ShadowVisibilityIntervals.mjs";

test("binary16 intervals handle zero, subnormal and the asymmetric normal power-of-two transition", () => {
  assert.deepEqual(halfFloatInterval(0), [0, 2 ** -25]);
  assert.deepEqual(halfFloatInterval(2 ** -24), [2 ** -25, 3 * 2 ** -25]);
  assert.deepEqual(halfFloatInterval(1), [1 - 2 ** -12, 1 + 2 ** -11]);
  assert.deepEqual(halfFloatInterval(2 ** -14), [2 ** -14 - 2 ** -25, 2 ** -14 + 2 ** -25]);
});
test("finite non-half or negative observations fail before producing a visibility budget", () => {
  for (const value of [NaN, Infinity, -.1, .1, 70000]) assert.throws(() => halfFloatInterval(value));
});
test("a half visibility is recovered from distinct positive RGB control intensities", () => {
  const result = shadowVisibilityInterval([.5, .25, .125], [1, .5, .25]);
  assert(result.minimum <= .5 && result.maximum >= .5); assert(result.maximum - result.minimum < .001);
  const blocked = shadowVisibilityInterval([0, 0, 0], [1, .5, .25]); assert.equal(blocked.minimum, 0); assert(blocked.maximum < 1e-6);
  const lit = shadowVisibilityInterval([1, .5, .25], [1, .5, .25]); assert.equal(lit.maximum, 1);
});
test("inconsistent channel attenuation and zero controls are rejected", () => {
  assert.throws(() => shadowVisibilityInterval([.5, .5, .125], [1, .5, .25]), /one pure-direct/);
  assert.throws(() => shadowVisibilityInterval([0, 0, 0], [0, .5, .25]), /positive/);
});
test("two quantization intervals must actually overlap; a different shadow factor stays a gap", () => {
  const a = shadowVisibilityInterval([.5, .25, .125], [1, .5, .25]);
  assert.deepEqual(intersectShadowVisibility(a, a), { overlaps: true, gap: 0 });
  const b = shadowVisibilityInterval([.25, .125, .0625], [1, .5, .25]);
  const result = intersectShadowVisibility(a, b); assert.equal(result.overlaps, false); assert(result.gap > .24);
});
