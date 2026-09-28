// T17 跨端位姿配对对比:读 Web 与 Native 各自导出的逐步位姿 JSON,
// 计算逐步最大位置差与旋转差,输出容差摘要。
// 运行:node apps/web/scripts/t17-compare-cross-tolerance.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const directory = resolve(repoRoot, "test-output/t17-cross-tolerance");
const web = JSON.parse(readFileSync(resolve(directory, "web-stack-poses.json"), "utf8"));
const native = JSON.parse(readFileSync(resolve(directory, "native-stack-poses.json"), "utf8"));

if (web.meta.steps !== native.meta.steps || web.meta.boxes.length !== native.meta.boxes.length) {
  throw new Error("pairing inputs diverge in steps or box count");
}

const quatAngle = (a, b) =>
  2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));

const perStep = [];
const perBoxMax = web.meta.boxes.map(() => ({ position: 0, rotation: 0 }));
let firstMillimetreStep = null;

for (let step = 0; step < web.meta.steps; step += 1) {
  let maxPosition = 0;
  let maxRotation = 0;
  for (let box = 0; box < web.meta.boxes.length; box += 1) {
    const w = web.poses[step][box];
    const n = { p: native.translations[step][box], q: native.rotations[step][box] };
    const position = Math.hypot(w.p[0] - n.p[0], w.p[1] - n.p[1], w.p[2] - n.p[2]);
    const rotation = quatAngle(w.q, n.q);
    maxPosition = Math.max(maxPosition, position);
    maxRotation = Math.max(maxRotation, rotation);
    perBoxMax[box].position = Math.max(perBoxMax[box].position, position);
    perBoxMax[box].rotation = Math.max(perBoxMax[box].rotation, rotation);
    if (position > 1e-3 && firstMillimetreStep === null) firstMillimetreStep = step + 1;
  }
  perStep.push({ step: step + 1, maxPosition, maxRotation });
}

const globalMaxPosition = Math.max(...perStep.map((entry) => entry.maxPosition));
const globalMaxRotation = Math.max(...perStep.map((entry) => entry.maxRotation));
const finalEntry = perStep[perStep.length - 1];

const summary = {
  meta: {
    web: web.meta,
    native: native.meta,
    aligned: {
      units: "metres/seconds",
      fixedStepSeconds: 1 / 60,
      gravity: [0, -9.81, 0],
      solverIterations: 8,
      damping: 0,
      ccd: true,
      mass: 1,
      friction: 0.6,
      restitution: 0,
    },
    unalignedKnownDifferences: [
      "rapier3d-compat 0.19.3 WASM lacks the enhanced-determinism feature compiled into native rapier3d 0.35.3",
      "contact softness/solver defaults inside IntegrationParameters are version defaults on both ends and were not frozen",
    ],
  },
  globalMaxPositionMeters: globalMaxPosition,
  globalMaxRotationRadians: globalMaxRotation,
  globalMaxRotationDegrees: (globalMaxRotation * 180) / Math.PI,
  firstStepOverOneMillimetre: firstMillimetreStep,
  finalStep: finalEntry,
  perBoxMax: web.meta.boxes.map((id, index) => ({ id, ...perBoxMax[index] })),
  perStep,
};

mkdirSync(directory, { recursive: true });
writeFileSync(resolve(directory, "summary.json"), JSON.stringify(summary, null, 2));

const at = (step) => perStep[step - 1];
console.log("T17 cross-end pairing summary (web 0.19.3 vs native 0.35.3, 8 solver iterations)");
console.log(`steps=${web.meta.steps} globalMaxPosition=${globalMaxPosition.toExponential(3)} m`);
console.log(`globalMaxRotation=${globalMaxRotation.toExponential(3)} rad (${summary.globalMaxRotationDegrees.toFixed(4)} deg)`);
console.log(`firstStepOverOneMillimetre=${String(firstMillimetreStep)}`);
for (const step of [1, 5, 10, 30, 60, 90, 120, 150, 180]) {
  const entry = at(step);
  console.log(`step ${String(step).padStart(3)}: pos=${entry.maxPosition.toExponential(3)} m rot=${entry.maxRotation.toExponential(3)} rad`);
}
console.log(`perBoxMax=${JSON.stringify(summary.perBoxMax)}`);
