import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { compareClothCalibration } from "./c5ClothCalibration.mjs";
import { compareMechanisms } from "./c5MechanismComparison.mjs";
const hash = text => createHash("sha256").update(text).digest("hex");
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const finite = value => typeof value === "number" ? Number.isFinite(value)
  : Array.isArray(value) ? value.every(finite) : Object.values(value).every(finite);

/** Independent engines have different solvers; report differences, gate only declared invariants. */
export function compareBullet({ webText, nativeText, clothText, bulletText, webHingeText, nativeHingeText, ...mechanismTexts }) {
  const web = JSON.parse(webText), native = JSON.parse(nativeText), cloth = JSON.parse(clothText), bullet = JSON.parse(bulletText);
  if (bullet.version !== "3.2.7" || bullet.inputs?.["web-stack-poses.json"] !== hash(webText)
    || bullet.inputs?.["cloth-input.json"] !== hash(clothText)) throw Error("Bullet version/input provenance mismatch");
  const keys = ["scenario", "halfExtents", "mass", "friction", "restitution", "gravity", "fixedStepSeconds", "steps",
    "solverIterations", "ccd", "damping", "topBoxInitialVelocity", "boxes"];
  for (const key of keys) if (!(key in web.meta) || !(key in native.meta) || !isDeepStrictEqual(web.meta[key], native.meta[key])) throw Error(`Stack input mismatch: ${key}`);
  if (web.meta.steps !== 180 || web.meta.boxes.length !== 3 || cloth.steps !== 240 || cloth.pinned.length !== 2)
    throw Error("Unexpected golden case shape");
  for (const [name, runs, steps, nodes] of [["stack", bullet.stack, 180, 3], ["cloth", bullet.cloth, 240, 144], ["freeFall", bullet.freeFall, 30, 144]]) {
    if (runs?.length !== 2 || runs.some(run => run.length !== steps || run.some(frame => frame.length !== nodes))
      || !finite(runs)) throw Error(`Incomplete/non-finite Bullet ${name} output`);
    if (JSON.stringify(runs[0]) !== JSON.stringify(runs[1])) throw Error(`Bullet ${name} repetition drift`);
  }
  if (web.poses?.length !== 180 || native.translations?.length !== 180 || native.rotations?.length !== 180
    || cloth.runs?.length !== 2 || !finite(web.poses) || !finite(native.translations) || !finite(native.rotations)
    || !finite(cloth.runs)) throw Error("Incomplete production golden output");
  if (JSON.stringify(cloth.runs[0]) !== JSON.stringify(cloth.runs[1])) throw Error("XPBD repetition drift");
  const stackErrors = { web: { position: 0, angle: 0 }, native: { position: 0, angle: 0 } };
  const angle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.reduce((s, v, i) => s + v * b[i], 0))));
  for (let t = 0; t < 180; t++) for (let i = 0; i < 3; i++) {
    const reference = bullet.stack[0][t][i];
    for (const [side, point, rotation] of [["web", web.poses[t][i].p, web.poses[t][i].q],
      ["native", native.translations[t][i], native.rotations[t][i]]]) {
      stackErrors[side].position = Math.max(stackErrors[side].position, distance(reference.p, point));
      stackErrors[side].angle = Math.max(stackErrors[side].angle, angle(reference.q, rotation));
    }
  }
  let maxClothPositionDifference = 0, maxBulletAnchorDrift = 0;
  for (let t = 0; t < 240; t++) for (let i = 0; i < 144; i++) {
    maxClothPositionDifference = Math.max(maxClothPositionDifference, distance(bullet.cloth[0][t][i], cloth.runs[0].poses[t][i]));
    if (cloth.pinned.includes(i)) maxBulletAnchorDrift = Math.max(maxBulletAnchorDrift,
      distance(bullet.cloth[0][t][i], cloth.runs[0].initial[i]));
  }
  if (maxBulletAnchorDrift > 1e-6) throw Error("Bullet fixed anchor drift");
  if (cloth.freeFall?.steps !== 30 || cloth.freeFall.runs?.length !== 2 || !finite(cloth.freeFall.runs)) throw Error("Missing free-fall reference");
  let freeFallMaxError = 0;
  for (let t = 0; t < 30; t++) for (let i = 0; i < 144; i++) freeFallMaxError = Math.max(freeFallMaxError,
    distance(bullet.freeFall[0][t][i], cloth.freeFall.runs[0].poses[t][i]));
  if (freeFallMaxError > 5e-5) throw Error("Matched free-fall integration drift");
  const wh = JSON.parse(webHingeText), nh = JSON.parse(nativeHingeText);
  if (bullet.inputs["web-hinge.json"] !== hash(webHingeText) || bullet.hinge?.length !== 2
    || JSON.stringify(bullet.hinge[0]) !== JSON.stringify(bullet.hinge[1])) throw Error("Hinge input/repetition drift");
  for (const [name, actual, expected] of [["steps", nh.steps, wh.meta.steps], ["mass", nh.mass, wh.meta.mass],
    ["step", nh.stepSeconds, wh.meta.fixedStep], ["lower", nh.limitMin, wh.meta.limitMin], ["upper", nh.limitMax, wh.meta.limitMax],
    ["velocity", nh.targetVelocity, wh.meta.motorTargetVelocity], ["strength", nh.strength, wh.meta.motorStrength]]) {
    if (actual !== expected) throw Error(`Hinge authored input mismatch: ${name}`);
  }
  for (const leg of [wh, nh, bullet.hinge[0]]) {
    if (leg.limited?.length !== 120 || leg.control?.length !== 120 || !finite(leg.limited) || !finite(leg.control)) throw Error("Missing hinge trajectory");
    if (leg.repeat && JSON.stringify(leg.repeat) !== JSON.stringify(leg.limited)) throw Error("Production hinge repetition drift");
    if (Math.max(...leg.limited) > .55 || Math.min(...leg.limited) < -.55
      || leg.limited.at(-1) < .45 || leg.limited.at(-1) > .55 || leg.control.at(-1) <= 1) throw Error("Hinge limit/control invariant failed");
  }
  const hingeAngleErrors = Object.fromEntries([["web", wh], ["native", nh]].map(([side, leg]) => [side,
    Math.max(...leg.limited.map((v, i) => Math.abs(v - bullet.hinge[0].limited[i])))]));
  return { passed: true, scope: "independent-test-oracle-record", version: bullet.version,
    stackErrors, hingeAngleErrors, maxClothPositionDifference, maxBulletAnchorDrift, freeFallMaxError, repeatStable: true,
    finiteStiffnessCalibration: compareClothCalibration(cloth, bullet),
    mechanisms: compareMechanisms(mechanismTexts, bullet),
    accuracyEquivalent: false, findings: ["Full cloth topology/damping family differs; matching finite stiffness subset converges within its registered gate"],
    inputHashes: { web: hash(webText), native: hash(nativeText), cloth: hash(clothText) },
    knownInputDifferences: ["Bullet product friction mapped sqrt(0.6) per collider; Rapier average is 0.6",
      "Bullet sequential impulse/contact ERP vs Rapier solver/contact slop",
      "Bullet hinge torque force10 vs Rapier motor strength10; invariant/angle records only",
      "Bullet triangular mass-spring stiffness40/damping0.1 vs XPBD structural+both diagonals compliance0/substep damping0.01"],
    excluded: ["solver trajectory equivalence", "full cloth finite-stiffness family"] };
}
