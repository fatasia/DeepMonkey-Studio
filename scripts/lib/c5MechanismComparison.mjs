import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
const hash = text => createHash("sha256").update(text).digest("hex");
const same = isDeepStrictEqual;
const numbers = (a, count) => a?.length === count && a.every(Number.isFinite);
const positions = a => a?.length === 240 && a.every(p => numbers(p, 3));
const maxError = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

/** Gate authored mechanical invariants and record distinct solvers' actual trajectories. */
export function compareMechanisms({ webGearText, nativeGearText, webSliderText, nativeSliderText }, bullet) {
  const wg = JSON.parse(webGearText), ng = JSON.parse(nativeGearText);
  const ws = JSON.parse(webSliderText), ns = JSON.parse(nativeSliderText);
  if (bullet.inputs["web-gear.json"] !== hash(webGearText) || bullet.inputs["web-slider.json"] !== hash(webSliderText))
    throw Error("Mechanism input provenance mismatch");
  for (const gear of [wg, ng]) {
    const m = gear.meta;
    if (m.driverVelocity !== 4 || m.ratio !== -2 || m.stiffness !== 40 || m.damping !== 20
      || m.fixedStepSeconds !== 1 / 60 || m.steps !== 240 || m.solverIterations !== 8 || !same(m.gravity, [0, 0, 0]))
      throw Error("Gear authored input mismatch");
  }
  for (const slider of [ws, ns]) if (!same(slider.meta, {
    mass: .5, target: .05, stiffness: 40, damping: 12, step: 1 / 60, steps: 240, solverIterations: 8 }))
    throw Error("Slider authored input mismatch");
  if (bullet.gear?.length !== 2 || bullet.slider?.length !== 2 || !same(bullet.gear[0], bullet.gear[1])
    || !same(bullet.slider[0], bullet.slider[1])) throw Error("Mechanism repetition drift");
  const gearMetrics = [wg, ng, bullet.gear[0]].map(gear => {
    const a = gear.anglesDriver, b = gear.anglesFollower;
    if (!numbers(a, 240) || !numbers(b, 240)) throw Error("Missing actual gear trajectory");
    const da = a[239] - a[120], db = b[239] - b[120], ratio = db / da, residual = Math.abs(db + 2 * da);
    if (Math.abs(da) < 1 || Math.abs(ratio + 2) > .04 || residual > .1) throw Error("Gear ratio/residual invariant failed");
    return { ratio, residual };
  });
  const sliderMetrics = [ws, ns, { positions: bullet.slider[0] }].map(slider => {
    const points = slider.positions;
    if (!positions(points) || (slider.repeat && !same(slider.repeat, points))) throw Error("Slider output/repetition drift");
    const settledMean = points.slice(-30).reduce((s, p) => s + p[0], 0) / 30;
    const lateralDrift = Math.max(...points.map(p => Math.hypot(p[1], p[2])));
    if (Math.abs(settledMean - .05) > .005 || lateralDrift > .001) throw Error("Slider settle/lateral invariant failed");
    return { settledMean, lateralDrift };
  });
  return { gearMetrics, sliderMetrics, repeatStable: true, gearFollowerAngleError: {
    web: maxError(wg.anglesFollower, bullet.gear[0].anglesFollower),
    native: maxError(ng.anglesFollower, bullet.gear[0].anglesFollower) }, sliderPositionError: {
    web: maxError(ws.positions.map(p => p[0]), bullet.slider[0].map(p => p[0])),
    native: maxError(ns.positions.map(p => p[0]), bullet.slider[0].map(p => p[0])) },
    semanticDifferences: ["Bullet native gear constraint vs Rapier follower servo",
      "Bullet explicit PD force vs Rapier implicit ForceBased motor"] };
}
