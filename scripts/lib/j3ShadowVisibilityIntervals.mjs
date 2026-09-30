import assert from "node:assert/strict";

/** Neighbour midpoint enclosure for a nonnegative, finite observed binary16 value. */
export function halfFloatInterval(value) {
  assert(Number.isFinite(value) && value >= 0 && value <= 65504, "finite nonnegative HDR half value required");
  if (value === 0) return [0, 2 ** -25];
  const exponent = Math.floor(Math.log2(value));
  const nextStep = Math.max(2 ** -24, 2 ** (exponent - 10));
  assert.equal(Math.round(value / nextStep) * nextStep, value, "observed HDR must be exactly representable as binary16");
  const previousStep = value === 2 ** exponent && exponent > -14 ? nextStep / 2 : nextStep;
  return [Math.max(0, value - previousStep / 2), value + nextStep / 2];
}

/** Pure-direct HDR / matched unshadowed HDR: independent quantization budget, no fitted epsilon. */
export function shadowVisibilityInterval(shadowed, unshadowed) {
  assert.equal(shadowed.length, 3); assert.equal(unshadowed.length, 3);
  // One f32 visibility multiply can round before storage into binary16.
  const f32RelativeBudget = 2 ** -23;
  const channels = shadowed.map((value, lane) => {
    const numerator = halfFloatInterval(value), denominator = halfFloatInterval(unshadowed[lane]);
    assert(denominator[0] > 0, "unshadowed control must be positive in all three HDR channels");
    return [numerator[0] * (1 - f32RelativeBudget) / denominator[1],
      numerator[1] * (1 + f32RelativeBudget) / denominator[0]];
  });
  const minimum = Math.max(0, ...channels.map(interval => interval[0]));
  const maximum = Math.min(1, ...channels.map(interval => interval[1]));
  assert(minimum <= maximum, "RGB channels do not admit one pure-direct shadow visibility");
  return { minimum, maximum, channels, budget: "binary16-neighbour-midpoints-plus-one-f32-multiply" };
}

export function intersectShadowVisibility(a, b) {
  return { overlaps: Math.max(a.minimum, b.minimum) <= Math.min(a.maximum, b.maximum),
    gap: Math.max(0, a.minimum - b.maximum, b.minimum - a.maximum) };
}
