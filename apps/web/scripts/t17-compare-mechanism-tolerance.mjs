// T17 机构驱动跨端位姿配对对比:读 Web 与 Native 各自导出的逐步位姿 JSON,
// 计算逐步最大位置差,输出容差摘要(≤5 mm 口径)。
// 运行:node apps/web/scripts/t17-compare-mechanism-tolerance.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const directory = resolve(repoRoot, "test-output/t17-mechanism");

const scenarios = [
  { name: "piston-crank", web: "web-piston-poses.json", native: "native-piston-poses.json", bodies: ["body-piston"] },
  { name: "slider-rail", web: "web-slider-poses.json", native: "native-slider-poses.json", bodies: ["body-slider"] },
  {
    name: "combined-shaft-crank-slider",
    web: "web-combined-poses.json",
    native: "native-combined-poses.json",
    // Web 端 combined 记录按 body 键名展开;Native 端为统一 positions 数组(活塞)。
    bodies: ["body-piston"],
    webPositions: (payload) => payload.positions.map((entry) => entry["body-piston"]),
  },
];

const summarize = (scenario, webPayload, nativePayload) => {
  const webPositions = scenario.webPositions
    ? scenario.webPositions(webPayload)
    : webPayload.positions;
  const nativePositions = nativePayload.positions;
  if (webPositions.length !== nativePositions.length || webPayload.meta.steps !== nativePayload.meta.steps) {
    throw new Error(`${scenario.name}: pairing inputs diverge in step count`);
  }
  const perStep = [];
  let firstMillimetreStep = null;
  let maxPosition = 0;
  for (let step = 0; step < webPositions.length; step += 1) {
    const w = webPositions[step];
    const n = nativePositions[step];
    const position = Math.hypot(w[0] - n[0], w[1] - n[1], w[2] - n[2]);
    maxPosition = Math.max(maxPosition, position);
    if (position > 1e-3 && firstMillimetreStep === null) firstMillimetreStep = step + 1;
    perStep.push({ step: step + 1, position });
  }
  return {
    scenario: scenario.name,
    steps: webPayload.meta.steps,
    globalMaxPositionMeters: maxPosition,
    globalMaxPositionMillimetres: maxPosition * 1e3,
    firstStepOverOneMillimetre: firstMillimetreStep,
    finalStep: perStep[perStep.length - 1],
    withinFiveMillimetres: maxPosition <= 5e-3,
    perStep,
  };
};

const summaries = scenarios.map((scenario) => {
  const webPayload = JSON.parse(readFileSync(resolve(directory, scenario.web), "utf8"));
  const nativePayload = JSON.parse(readFileSync(resolve(directory, scenario.native), "utf8"));
  return summarize(scenario, webPayload, nativePayload);
});

const summary = {
  meta: {
    web: { rapier: "0.19.3-compat", solverIterations: 8 },
    native: { rapier: "0.35.3", solverIterations: 8 },
    aligned: {
      units: "metres/seconds",
      fixedStepSeconds: 1 / 60,
      gravity: [0, 0, 0],
      solverIterations: 8,
      damping: 0,
      colliderGeometry: "z-staggered per-body colliders, identical on both ends",
    },
    unalignedKnownDifferences: [
      "rapier3d-compat 0.19.3 WASM lacks the enhanced-determinism feature compiled into native rapier3d 0.35.3",
      "IntegrationParameters contact softness/solver defaults are version defaults on both ends and were not frozen",
    ],
  },
  toleranceClause: "cross-end per-step position difference ≤ 5 mm / ≤ 0.02 rad",
  scenarios: summaries.map(({ perStep, ...rest }) => rest),
};

mkdirSync(directory, { recursive: true });
writeFileSync(resolve(directory, "mechanism-summary.json"), JSON.stringify({ ...summary, perStep: summaries }, null, 2));

console.log("T17 mechanism cross-end pairing summary (web 0.19.3 vs native 0.35.3, 8 solver iterations)");
for (const entry of summaries) {
  console.log(
    `${entry.scenario}: steps=${entry.steps} maxPos=${entry.globalMaxPositionMillimetres.toFixed(4)} mm`
    + ` first>1mm@step=${entry.firstStepOverOneMillimetre ?? "-"} final=${entry.finalStep.position.toExponential(3)} m`
    + ` within5mm=${entry.withinFiveMillimetres}`,
  );
}
if (summaries.some((entry) => !entry.withinFiveMillimetres)) process.exitCode = 1;
