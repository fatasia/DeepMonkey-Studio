import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lightInfluenceBounds, minimumFrameBudget } from "../src/lighting/probeInvalidationConvergence.ts";
import { ProbeClipmapUpdateScheduler,
  type ProbeClipmapFrameRequest } from "../src/lighting/probeClipmapUpdateScheduler.ts";
import { probeClipmapOptionsForQuality, type ProbeClipmapPlan, type ProbeVector3 } from "../src/lighting/probeClipmapPlan.ts";
import { emitProbeRadianceKernelWgsl } from "../src/rayTracing/probeRadianceKernel.ts";
import { f5ProbeInvalidationKernel } from "./f5ProbeInvalidationKernel.mjs";
import { prepareT02ProbeJoint, packUniform, packProbeParams, decodeProbeField, toBase64,
  GRID, CAMERA, PROBE_PARAM_BYTES, CAPTURE_BYTES_PER_ROW, CAPTURE_BUFFER_BYTES } from "./t02ProbePrep.mts";

// F5 失效收敛 GPU 联测（headless Chrome + 真机 WebGPU）：开关灯 / 移动光源下，
// 「真实 ProbeClipmapUpdateScheduler 在环」（失效 → dirtyBounds → 预算/LEVEL_WHEEL →
// 逐帧批次）驱动生产 probeRadianceKernel 逐帧重捕获，量化探针场亮度残差随帧衰减曲线，
// 得出收敛帧数基线。达标口径沿 G3-S1/T02 与 Z1 审计：60fps 折算 1 秒内 RMSE ≤10%、
// 单调衰减、预算守恒；对照 probeInvalidationConvergence 推演档（乐观上界）。
// 诚实边界：帧数按批次帧计（每帧一次 dispatch+读回的联测节奏），非 60fps 真画面
// 端到端；wallMs 含逐帧 mapAsync 读回开销，纯 dispatch 成本另测。

const require = createRequire(import.meta.url);
const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
const outputDir = fileURLToPath(new URL("../../../test-output/deep-core/F5/probe-invalidation-gpu-r1/", import.meta.url));
const BUDGET = 8; // 产品档（Z1 审计：pbrRenderer 8 probe/帧）
const percentiles = (values: readonly number[]): { mean: number; p50: number; p95: number } => {
  const sorted = [...values].sort((a, b) => a - b);
  return { mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: sorted[Math.floor(sorted.length / 2)]!, p95: sorted[Math.floor(sorted.length * 0.95)]! };
};

const prep = prepareT02ProbeJoint();
const { scene, packet, rayScene, packed, positions } = prep;
const probeCount = positions.length;
const dirtyAll = positions.map((_, index) => index);
const productionWgsl = emitProbeRadianceKernelWgsl();

// ---- 真实调度器在环：灯光失效事件（dirtyBounds 首帧一次性提供，pending 滚动清空）----
interface ScheduledInvalidation {
  batches: readonly (readonly number[])[];
  framesUsed: number;
  level0Origin: readonly number[];
}
const scheduleInvalidation = async (dirtyBounds: readonly ReturnType<typeof lightInfluenceBounds>[]): Promise<ScheduledInvalidation> => {
  const scheduler = new ProbeClipmapUpdateScheduler({ async setValidated(plan: ProbeClipmapPlan) {
    return { status: "reused", resource: { plan }, evidence: { generation: 1,
      allocatedBytes: plan.profile.estimatedBytes, updatedBytes: 0, updateCount: plan.updates.length,
      createdBufferCount: 0, reusedBufferCount: 3 } };
  } }, { frameBudget: BUDGET, cameraCutBudget: Math.ceil(BUDGET * 1.5) });
  const batches: number[][] = [];
  let level0Origin: readonly number[] = [], frame = 0;
  for (; frame < 96; frame++) {
    const request: ProbeClipmapFrameRequest = { frame, deviceEpoch: "gpu-1",
      viewport: [1280, 720], cameraPosition: CAMERA, sceneBounds: scene.bounds,
      options: { ...probeClipmapOptionsForQuality("balanced"), levelCount: 2,
        gridSize: [...GRID] as [number, number, number], baseSpacing: 1 },
      dirtyBounds: frame === 0 ? dirtyBounds : [] };
    const result = await scheduler.submit(request);
    if (result.status !== "committed") throw new Error(`scheduler status ${result.status}`);
    const plan = result.plan!;
    const level0 = plan.levels.find(level => level.level === 0)!;
    level0Origin = level0.origin;
    // level0 origin 必须与探针网格原点 [1,1,1] 对齐（camera [4,1.5,3] 的确定性产物）。
    if (level0Origin.some((value, axis) => Math.abs(value - 1) > 1e-6)) {
      throw new Error(`level0 origin ${level0Origin} is not aligned with the probe grid origin`);
    }
    batches.push(plan.updates.filter(update => update.level === 0)
      .map(update => cellToProbe(update.position)));
    if (plan.updates.length === 0 && plan.deferred.length === 0) break;
  }
  if (frame >= 96) throw new Error("scheduler did not drain the invalidation within 96 frames");
  return { batches, framesUsed: frame + 1, level0Origin };
};
// update.position = level0 origin + cell·spacing；cell = position − [1,1,1]（行主序探针下标）。
const cellToProbe = (position: ProbeVector3): number => {
  const cell = position.map(value => value - 1);
  if (cell.some(value => !Number.isInteger(value) || value < 0)) {
    throw new Error(`level0 cell ${position} is not aligned with the probe grid`);
  }
  return (cell[2]! * GRID[1]! + cell[1]!) * GRID[0]! + cell[0]!;
};

// ---- 场景组：关灯（intensity 1→0）与移灯（方向光旋转） ----
const normalize = (vector: readonly number[]): ProbeVector3 => {
  const length = Math.hypot(...vector);
  return Object.freeze([vector[0]! / length, vector[1]! / length, vector[2]! / length]) as ProbeVector3;
};
const movedScene = { ...scene, light: { surfaceToLightWorld: normalize([-0.4, 1, 0.25]), intensity: 1 } };
const powerOff = await scheduleInvalidation([scene.bounds]); // 方向光影响全场
const lightMove = await scheduleInvalidation([scene.bounds]);
const probeParamsFull = toBase64(packProbeParams(positions, dirtyAll));
const toFrames = (schedule: ScheduledInvalidation,
  uniform: (batch: readonly number[]) => Uint8Array) => schedule.batches.map(batch => ({
    uniformB64: toBase64(uniform(batch)),
    paramsB64: toBase64(packProbeParams(positions, [...batch])), updated: batch.length, level: 0 }));
const scenarios = [
  { name: "light-off", staleUniformB64: toBase64(packUniform(scene, probeCount, 1, 32)),
    targetUniformB64: toBase64(packUniform(scene, probeCount, 0, 32)),
    frames: toFrames(powerOff, batch => packUniform(scene, batch.length, 0, 32)) },
  { name: "light-move", staleUniformB64: toBase64(packUniform(scene, probeCount, 1, 32)),
    targetUniformB64: toBase64(packUniform(movedScene, probeCount, 1, 32)),
    frames: toFrames(lightMove, batch => packUniform(movedScene, batch.length, 1, 32)) },
];

const server = createServer((_request, response) => response.writeHead(200, { "content-type": "text/html" })
  .end("<html><body style=\"background:#101820\"></body></html>"));
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true, args: ["--enable-unsafe-webgpu"] });
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
  await page.goto(`http://127.0.0.1:${port}`);
  const gpu = await page.evaluate(f5ProbeInvalidationKernel, {
    wgslRadiance: productionWgsl,
    sceneB64: { nodes: toBase64(packed.nodeBytes), instances: toBase64(packed.recordBytes),
      vertices: toBase64(packed.vertices), indices: toBase64(packed.indices),
      order: toBase64(packed.order),
      albedos: toBase64(new Float32Array(rayScene.materials.flatMap(binding => {
        const material = packet.materials.find(candidate => candidate.id === binding.material.id)!;
        return [...material.baseColor, 1]; }))) },
    uniformCapacityBytes: 576,
    probeParamsFullB64: probeParamsFull, probeParamCount: probeCount, probeParamBytes: PROBE_PARAM_BYTES,
    workgroupsFull: Math.ceil(probeCount / 64),
    capture: { width: GRID[0], height: GRID[1], layers: GRID[2],
      bytesPerRow: CAPTURE_BYTES_PER_ROW, rowsPerImage: GRID[1], bufferBytes: CAPTURE_BUFFER_BYTES },
    scenarios, timing: { warmup: 5, samples: 30,
      uniformB64: toBase64(packUniform(scene, BUDGET, 1, 32)),
      paramsB64: toBase64(packProbeParams(positions, positions.map((_, index) => index).slice(0, BUDGET))) },
  });
  const decode = (entry: { halfB64: string }): ProbeVector3[] =>
    decodeProbeField(Buffer.from(entry.halfB64, "base64"), probeCount);
  const convergence: Record<string, unknown> = {};
  for (const scenario of scenarios) {
    const data = gpu.scenarios[scenario.name]!;
    const staleField = decode(data.staleField), targetField = decode(data.targetField);
    const fieldLuminance = (field: readonly ProbeVector3[]): number => field.reduce((total, vector) =>
      total + (vector[0]! + vector[1]! + vector[2]!) / 3, 0) / field.length;
    const norm = (vector: ProbeVector3): number => Math.hypot(vector[0]!, vector[1]!, vector[2]!);
    // 亮度残差归一化分母 = max(mean‖target‖, mean‖stale‖)（可见尺度）：关灯场景的新稳态
    // 近全黑（室内 miss 占比极小），对 target 归一会把分母推到 0 量级、RMSE 爆到数百倍，
    // 「10% 残差」就失去物理意义；以变化前后较大亮度为基准两场景同尺可比。
    const scale = Math.max(staleField.reduce((total, vector) => total + norm(vector), 0) / probeCount,
      targetField.reduce((total, vector) => total + norm(vector), 0) / probeCount);
    const residualRmse = (stored: readonly ProbeVector3[]): number => {
      const square = dirtyAll.reduce((total, index) => total + stored[index]!.reduce(
        (sum, value, axis) => sum + (value - targetField[index]![axis]!) ** 2, 0), 0);
      return scale > 0 ? Math.sqrt(square / dirtyAll.length) / scale : 0;
    };
    const initialRmse = residualRmse(staleField);
    const curve = data.frames.map(frame => ({ rmse: residualRmse(decode(frame)),
      updated: frame.updated, wallMs: frame.wallMs, level: frame.level }));
    const framesToTolerance = curve.findIndex(entry => entry.rmse <= 0.10) + 1;
    convergence[scenario.name] = { initialRmse, finalRmse: curve.at(-1)!.rmse,
      residualScale: Number(scale.toFixed(6)),
      staleMeanLuminance: Number(fieldLuminance(staleField).toFixed(5)),
      targetMeanLuminance: Number(fieldLuminance(targetField).toFixed(5)),
      framesToTolerance: framesToTolerance > 0 ? framesToTolerance : null,
      secondsAt60Fps: framesToTolerance > 0 ? Number((framesToTolerance / 60).toFixed(4)) : null,
      schedulerFramesUsed: scenario.name === "light-off" ? powerOff.framesUsed : lightMove.framesUsed,
      monotone: curve.every((entry, index) => entry.rmse <= (index === 0 ? initialRmse
        : curve[index - 1]!.rmse) + 1e-12),
      maxUpdatesPerFrame: Math.max(0, ...curve.map(entry => entry.updated)),
      frameWallMs: percentiles(curve.map(entry => entry.wallMs)),
      curve: [Number(initialRmse.toFixed(5)), ...curve.map(entry => Number(entry.rmse.toFixed(5)))] };
  }
  const meanLuminance = (field: readonly ProbeVector3[]): number => field.reduce((total, vector) =>
    total + (vector[0]! + vector[1]! + vector[2]!) / 3, 0) / field.length;
  const offData = gpu.scenarios["light-off"]!;
  const dispatchCostP50 = percentiles(gpu.dispatchDurations).p50;
  const checks = {
    noQueueErrors: gpu.queueErrors.length === 0 && gpu.messages.length === 0,
    overflowSentinelsZero: Object.values(gpu.scenarios).every(data =>
      (data.staleField as { overflowSentinel: number }).overflowSentinel === 0
      && (data.targetField as { overflowSentinel: number }).overflowSentinel === 0),
    lightOffConverges: (convergence["light-off"] as { framesToTolerance: number | null }).framesToTolerance !== null,
    lightMoveConverges: (convergence["light-move"] as { framesToTolerance: number | null }).framesToTolerance !== null,
    withinOneSecondAt60Fps: ["light-off", "light-move"].every(name =>
      (convergence[name] as { framesToTolerance: number | null }).framesToTolerance !== null
      && (convergence[name] as { framesToTolerance: number }).framesToTolerance / 60 <= 1),
    monotoneDecay: ["light-off", "light-move"].every(name =>
      (convergence[name] as { monotone: boolean }).monotone),
    shippedBudgetRespected: ["light-off", "light-move"].every(name =>
      (convergence[name] as { maxUpdatesPerFrame: number }).maxUpdatesPerFrame <= BUDGET),
    lightOffTargetDark: meanLuminance(decode(offData.targetField)) < 0.05,
    shippedBudgetCoversOneSecondFloor: BUDGET >= minimumFrameBudget(dirtyAll.length, 60, 1),
    dispatchFitsFrameBudget: dispatchCostP50 <= 16.7,
  };
  const evidence = {
    schema: "f5-probe-invalidation-gpu-evidence-v1", createdAt: new Date().toISOString(),
    lane: "f5-probe-invalidation-real-gpu",
    method: `真实 ProbeClipmapUpdateScheduler 在环（frameBudget=${BUDGET} 产品档、dirtyBounds 首帧一次性提供、pending 滚动清空）驱动生产 probeRadianceKernel（32 方向）逐帧重捕获；uniform 直射强度 ×π×|L| 尺度补偿；残差 = 脏域归一化 RMSE 对新光照稳态场`,
    honestNotes: [
      "帧数按调度批次帧计（每帧一次 dispatch+全场读回），非 60fps 真画面端到端；wallMs 含 mapAsync 读回。",
      "移动光源以方向光旋转近似（参考场景无点光）；lightInfluenceBounds 的局部失效语义由单测覆盖。",
      "调度器批次顺序（LEVEL_WHEEL + 距离）与推演排程（纯距离）不同，两者都以「刷新即精确捕获」为前提。",
    ],
    adapter: gpu.adapter, probeCount, shippedBudget: BUDGET,
    scheduler: { lightOffFrames: powerOff.framesUsed, lightMoveFrames: lightMove.framesUsed,
      level0Origin: powerOff.level0Origin },
    convergence, dispatchCostMs: percentiles(gpu.dispatchDurations),
    queueErrors: gpu.queueErrors, shaderMessages: gpu.messages,
    checks, allPass: Object.values(checks).every(Boolean),
  };
  await mkdir(outputDir, { recursive: true });
  await writeFile(`${outputDir}evidence.json`, JSON.stringify(evidence, null, 2));
  const assetFile = join(dirname(outputDir), "../../../docs/reports/deep-core/assets/f5-probe-invalidation-gpu.json");
  await writeFile(assetFile, JSON.stringify(evidence, null, 2));
  const framesOf = (name: string): string => String((convergence[name] as { framesToTolerance: number }).framesToTolerance);
  console.log(`f5 probe invalidation gpu: allPass=${evidence.allPass} `
    + `off=${framesOf("light-off")}f move=${framesOf("light-move")}f `
    + `offFinal=${((convergence["light-off"] as { finalRmse: number }).finalRmse * 100).toFixed(2)}% `
    + `dispatchP50=${dispatchCostP50.toFixed(3)}ms schedulerFrames=${powerOff.framesUsed}/${lightMove.framesUsed}`);
  if (!evidence.allPass) process.exitCode = 1;
} finally { await browser.close(); server.close(); }
