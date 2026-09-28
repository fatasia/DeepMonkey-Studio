// T17 位置马达与齿轮耦合跨端位姿配对对比:读 Web 与 Native 各自导出的逐步
// 位姿 JSON,计算逐步最大位置差,输出容差摘要(≤5 mm 口径,沿 T17 机构配对先例)。
// 运行:node apps/web/scripts/t17-compare-motor-gear-tolerance.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const directory = resolve(repoRoot, "test-output/t17-motor-gear");

const scenarios = [
  // 旋转体质心不动:伺服场景配对关节连续角(rad 口径),齿轮场景配对从动体位置。
  { name: "position-servo-revolute", web: "web-servo-poses.json", native: "native-servo-poses.json",
    webSeries: (payload) => payload.angles, nativeSeries: (payload) => payload.angles,
    unit: "rad", tolerance: 0.02 },
  { name: "gear-coupling-2to1", web: "web-gear-poses.json", native: "native-gear-poses.json",
    unit: "m", tolerance: 5e-3 },
];

const summarize = (scenario, webPayload, nativePayload) => {
  const webPositions = scenario.webSeries ? scenario.webSeries(webPayload) : webPayload.positions;
  const nativePositions = scenario.nativeSeries ? scenario.nativeSeries(nativePayload) : nativePayload.positions;
  if (webPositions.length !== nativePositions.length || webPayload.meta.steps !== nativePayload.meta.steps) {
    throw new Error(`${scenario.name}: pairing inputs diverge in step count`);
  }
  const perStep = [];
  let firstOverToleranceStep = null;
  let maxPosition = 0;
  for (let step = 0; step < webPositions.length; step += 1) {
    const w = webPositions[step];
    const n = nativePositions[step];
    const position = Array.isArray(w) ? Math.hypot(w[0] - n[0], w[1] - n[1], w[2] - n[2]) : Math.abs(w - n);
    maxPosition = Math.max(maxPosition, position);
    if (position > scenario.tolerance && firstOverToleranceStep === null) firstOverToleranceStep = step + 1;
    perStep.push({ step: step + 1, position });
  }
  return {
    scenario: scenario.name,
    steps: webPayload.meta.steps,
    unit: scenario.unit,
    globalMax: maxPosition,
    globalMaxMillimetres: scenario.unit === "m" ? maxPosition * 1e3 : undefined,
    firstStepOverTolerance: firstOverToleranceStep,
    finalStep: perStep[perStep.length - 1],
    withinTolerance: maxPosition <= scenario.tolerance,
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
      units: "metres/seconds/radians",
      fixedStepSeconds: 1 / 60,
      gravity: [0, 0, 0],
      solverIterations: 8,
      servoModel: "AccelerationBased position servo on both ends (gear coupling additionally wraps the target into the principal band and feeds forward ratio × driver velocity)",
      gains: { servo: { stiffness: 40, damping: 12 }, gear: { stiffness: 40, damping: 20 } },
    },
    unalignedKnownDifferences: [
      "rapier3d-compat 0.19.3 WASM lacks the enhanced-determinism feature compiled into native rapier3d 0.35.3",
      "IntegrationParameters contact softness/solver defaults are version defaults on both ends and were not frozen",
      "position-servo-revolute settled angle differs by ~1.4e-3 rad (web 1.50000 vs native 1.49865) before sleep freeze",
    ],
  },
  toleranceClause: "cross-end per-step position difference ≤ 5 mm / ≤ 0.02 rad (T17 pairing precedent)",
  scenarios: summaries.map(({ perStep, ...rest }) => rest),
};

mkdirSync(directory, { recursive: true });
writeFileSync(resolve(directory, "motor-gear-summary.json"), JSON.stringify({ ...summary, perStep: summaries }, null, 2));

console.log("T17 motor/gear cross-end pairing summary (web 0.19.3 vs native 0.35.3, 8 solver iterations)");
for (const entry of summaries) {
  const max = entry.unit === "m"
    ? `${entry.globalMaxMillimetres.toFixed(4)} mm`
    : `${entry.globalMax.toFixed(5)} rad`;
  console.log(
    `${entry.scenario}: steps=${entry.steps} max=${max}`
    + ` first>tol@step=${entry.firstStepOverTolerance ?? "-"} final=${entry.finalStep.position.toExponential(3)} ${entry.unit}`
    + ` withinTolerance=${entry.withinTolerance}`,
  );
}
if (summaries.some((entry) => !entry.withinTolerance)) process.exitCode = 1;
