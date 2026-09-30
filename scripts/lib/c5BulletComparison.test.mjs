import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compareBullet } from "./c5BulletComparison.mjs";
// Synthetic receipt shapes test rejection logic only; no physical accuracy claim.
function load() {
  const meta = { scenario: "stack-3boxes", halfExtents: .1, mass: 1, friction: .6, restitution: 0,
    gravity: [0, -9.81, 0], fixedStepSeconds: 1/60, steps: 180, solverIterations: 8, ccd: true,
    damping: { linear: 0, angular: 0 }, topBoxInitialVelocity: [.15, 0, 0], boxes: ["a", "b", "c"] };
  const positions = Array.from({ length: 180 }, () => Array.from({ length: 3 }, () => [0, 0, 0]));
  const rotations = positions.map(frame => frame.map(() => [0, 0, 0, 1]));
  const poses = positions.map((frame, t) => frame.map((p, i) => ({ p, q: rotations[t][i] })));
  const clothPoses = Array.from({ length: 240 }, () => Array.from({ length: 144 }, () => [0, 0, 0]));
  const runs = Array.from({ length: 2 }, () => ({ initial: clothPoses[0], poses: clothPoses }));
  const webText = JSON.stringify({ meta, poses }), nativeText = JSON.stringify({ meta, translations: positions, rotations });
  const freeFall = clothPoses.slice(0, 30);
  const clothText = JSON.stringify({ steps: 240, pinned: [132, 143], runs, freeFall: { steps: 30, runs: [
    { poses: freeFall }, { poses: freeFall }] } });
  const hash = text => createHash("sha256").update(text).digest("hex");
  const hinge = { limited: Array.from({ length: 120 }, () => .5), control: Array.from({ length: 120 }, () => 2) };
  const webHingeText = JSON.stringify({ ...hinge, meta: { steps: 120, mass: 1, fixedStep: 1/60, limitMin: -.5, limitMax: .5,
    motorTargetVelocity: 2, motorStrength: 10 } });
  const nativeHingeText = JSON.stringify({ ...hinge, steps: 120, mass: 1, stepSeconds: 1/60,
    limitMin: -.5, limitMax: .5, targetVelocity: 2, strength: 10 });
  const bulletText = JSON.stringify({ version: "3.2.7", inputs: { "web-stack-poses.json": hash(webText),
    "cloth-input.json": hash(clothText), "web-hinge.json": hash(webHingeText) }, stack: [poses, poses], cloth: [clothPoses, clothPoses],
    freeFall: [freeFall, freeFall], hinge: [hinge, hinge] });
  return { webText, nativeText, clothText, bulletText, webHingeText, nativeHingeText };
}
test("receipt repeat/input provenance and finite measurements", () => {
  const result = compareBullet(load()); assert.equal(result.repeatStable, true);
  assert.equal(result.scope, "independent-test-oracle-record"); assert.ok(result.stackErrors.web.position >= 0);
});
test("wrong source or pinned version cannot pass", () => {
  const input = load(), bullet = JSON.parse(input.bulletText); bullet.version = "different";
  assert.throws(() => compareBullet({ ...input, bulletText: JSON.stringify(bullet) }), /version\/input/);
  assert.throws(() => compareBullet({ ...input, webText: `${input.webText}\n` }), /provenance/);
});
test("empty/unstable outputs and moving anchors fail", () => {
  const input = load(), mutate = fn => { const b = JSON.parse(input.bulletText); fn(b); return { ...input, bulletText: JSON.stringify(b) }; };
  assert.throws(() => compareBullet(mutate(b => b.stack[0] = [])), /Incomplete/);
  assert.throws(() => compareBullet(mutate(b => b.stack[1][0][0].p[0] += .01)), /repetition/);
  assert.throws(() => compareBullet(mutate(b => {
    for (const run of b.cloth) run[0][132][0] += .01;
  })), /anchor/);
  assert.throws(() => compareBullet(mutate(b => {
    for (const run of b.freeFall) run[0][0][0] += .01;
  })), /free-fall/);
  assert.throws(() => compareBullet(mutate(b => {
    for (const run of b.hinge) run.limited[0] = .7;
  })), /invariant/);
});
