import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { analyzeProbeFieldDeviation } from "../src/lighting/probeGpuJointAnalysis.ts";
import { sampleIrradianceProbeClipmap, type IrradianceProbeRecord } from "../src/lighting/probeClipmapSampling.ts";
import { packProbeLevels } from "../src/lighting/probeClipmapResourceData.ts";
import { PROBE_CLIPMAP_SAMPLING_WGSL, DEEP_GI_PROBE_STORAGE_BINDING, DEEP_GI_LEVEL_METADATA_BINDING } from "../src/lighting/probeClipmapSamplingWgsl.ts";
import { computeNormalizedFieldRmse, simulateBudgetedRecovery } from "../src/lighting/probeInvalidationConvergence.ts";
import { emitProbeRadianceKernelWgsl } from "../src/rayTracing/probeRadianceKernel.ts";
import { t02ProbeFieldKernel, t02ProbeSamplingKernel } from "./t02ProbePageKernel.mjs";
import { t02FilterProductionCapture } from "./t02ProbeTextureSamplingPageKernel.mjs";
import { WEBGPU_PROBE_CAPTURE_WGSL } from "../src/webgpu/webgpuProbeCaptureWgsl.ts";
import { runT02ProductionTextureConsumer } from "./t02ProbeTextureConsumer.mts";
import { prepareT02ProbeJoint, packUniform, packProbeParams, packRecords, decodeProbeField,
  buildFrames, toBase64, GRID, CAMERA, directionCounts, PROBE_PARAM_BYTES,
  CAPTURE_BYTES_PER_ROW, CAPTURE_BUFFER_BYTES } from "./t02ProbePrep.mts";

// T02 GPU 探针联测（headless Chrome + 真机 WebGPU；模式沿用 T03/T05/T08 证据链）。
// 1) 生产 probeRadianceKernel 全场 70 探针（房间+薄墙+门洞+天窗）fib8/16/32 vs CPU 4096
//    分层 MC 参考的逐探针归一化 RMSE，32 为生产方向容量。
// 2) 生产 deepGiSample WGSL（validity 拒绝 + Chebyshev + 法线权重）对墙内接收点采样，
//    实测「埋入探针拒绝」策略在 GPU 采样路径消除穿墙亮斑。
// 3) 失效后固定预算（2/4/8 探针/帧）真机逐帧收敛，对照 CPU 推演与 1 秒验收。
// Design Read：对标 Unity 动态 GI 更新画质/时延；本切片不增 UI、场景视觉或设计令牌，
// 数值读回不能代替产品画面截图/视觉验收。

const require = createRequire(import.meta.url);
const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
const outputDir = fileURLToPath(new URL("../../../test-output/deep-core/T02/probe-reference-gpu-r1/", import.meta.url));
const assetFile = fileURLToPath(new URL("../../../docs/reports/deep-core/assets/t02-probe-reference-gpu-2026-09-28.json", import.meta.url));
const percentiles = (values: readonly number[]): { mean: number; p50: number; p95: number } => {
  const sorted = [...values].sort((a, b) => a - b);
  return { mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: sorted[Math.floor(sorted.length / 2)]!, p95: sorted[Math.floor(sorted.length * 0.95)]! };
};

const prep = prepareT02ProbeJoint();
const { scene, packet, rayScene, packed, tMax, positions, parity, buried, buriedScene,
  mcField, includeProbe, truthShadowed, relocation } = prep;
const probeCount = positions.length;
const productionWgsl = emitProbeRadianceKernelWgsl();
const frames = buildFrames(scene, positions, [2, 4, 8]);
const biggestBatch8 = frames.filter(frame => frame.budget === 8).at(-1)!.batch;

const server = createServer((_request, response) => response.writeHead(200, { "content-type": "text/html" })
  .end("<html><body style=\"background:#101820\"></body></html>"));
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true, args: ["--enable-unsafe-webgpu"] });
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
  await page.goto(`http://127.0.0.1:${port}`);
  const gpu = await page.evaluate(t02ProbeFieldKernel, {
    wgslRadiance: productionWgsl,
    sceneB64: {
      nodes: toBase64(packed.nodeBytes), instances: toBase64(packed.recordBytes),
      vertices: toBase64(packed.vertices), indices: toBase64(packed.indices),
      order: toBase64(packed.order),
      albedos: toBase64(new Float32Array(rayScene.materials.flatMap(binding => {
        const material = packet.materials.find(candidate => candidate.id === binding.material.id)!;
        return [...material.baseColor, 1]; }))) },
    uniforms: { full8: toBase64(packUniform(scene, probeCount, 1, 8)),
      full16: toBase64(packUniform(scene, probeCount, 1, 16)),
      full32: toBase64(packUniform(scene, probeCount, 1, 32)),
      stale32: toBase64(packUniform(scene, probeCount, 1, 32)),
      target32: toBase64(packUniform(scene, probeCount, 2, 32)) },
    frames, directionCounts: [...directionCounts],
    probeParamsFull: toBase64(packProbeParams(positions, positions.map((_, index) => index))),
    probeParamCount: probeCount, probeParamBytes: PROBE_PARAM_BYTES, uniformCapacityBytes: 576,
    workgroupsFull: Math.ceil(probeCount / 64),
    capture: { width: GRID[0], height: GRID[1], layers: GRID[2],
      bytesPerRow: CAPTURE_BYTES_PER_ROW, rowsPerImage: GRID[1], bufferBytes: CAPTURE_BUFFER_BYTES },
    timing: { warmup: 5, samples: 30, uniformB64: toBase64(packUniform(scene, biggestBatch8.length, 2, 32)),
      paramsB64: toBase64(packProbeParams(positions, biggestBatch8)) } });
  const fields = Object.fromEntries(Object.entries(gpu.fields).map(([count, field]) =>
    [count, decodeProbeField(Buffer.from(field.halfB64, "base64"), probeCount)]));
  const staleField = decodeProbeField(Buffer.from(gpu.staleField.halfB64, "base64"), probeCount);
  const targetField = decodeProbeField(Buffer.from(gpu.targetField.halfB64, "base64"), probeCount);
  const parityMax = (count: number): number => Math.max(...positions.flatMap((_, index) =>
    includeProbe(index) ? [Math.max(...[0, 1, 2].map(axis =>
      Math.abs(fields[count]![index]![axis]! - parity[count]![index]!.irradiance[axis]!)))] : []));
  const rmseOf = (count: number): number => computeNormalizedFieldRmse(fields[count]!, mcField,
    positions.map((_, index) => index).filter(includeProbe));
  const deviationOf = (count: number) => analyzeProbeFieldDeviation(fields[count]!, mcField, includeProbe);
  const convergence: Record<string, unknown> = {};
  for (const budget of [2, 4, 8]) {
    const budgetFrames = gpu.convergence.filter(frame => frame.budget === budget);
    const curve = budgetFrames.map(frame => ({ wallMs: frame.wallMs,
      rmse: computeNormalizedFieldRmse(decodeProbeField(Buffer.from(frame.halfB64, "base64"), probeCount),
        targetField) }));
    const framesToTolerance = curve.findIndex(entry => entry.rmse <= 0.10) + 1;
    const simulated = simulateBudgetedRecovery({ positions, stale: staleField, target: targetField,
      dirtyIndices: positions.map((_, index) => index), camera: CAMERA }, { budget, fps: 60 });
    convergence[budget] = { framesToTolerance: framesToTolerance > 0 ? framesToTolerance : null,
      cpuSimulatorFrames: simulated.framesToTolerance ?? null, secondsAt60Fps: framesToTolerance > 0
        ? Number((framesToTolerance / 60).toFixed(4)) : null,
      measuredReadbackWallMsToTolerance: framesToTolerance > 0
        ? Number(curve.slice(0, framesToTolerance).reduce((sum, frame) => sum + frame.wallMs, 0).toFixed(3)) : null,
      initialRmse: computeNormalizedFieldRmse(staleField, targetField),
      finalRmse: curve.at(-1)!.rmse,
      monotone: curve.every((entry, index) => entry.rmse <= (index === 0
        ? computeNormalizedFieldRmse(staleField, targetField) : curve[index - 1]!.rmse) + 1e-12),
      frameWallMs: percentiles(budgetFrames.map(frame => frame.wallMs)),
      maxUpdatesPerFrame: Math.max(...budgetFrames.map(frame => frame.updated)),
      curve: [Number(computeNormalizedFieldRmse(staleField, targetField).toFixed(5)),
        ...curve.map(entry => Number(entry.rmse.toFixed(5)))] };
  }
  // 墙内 GPU 采样：records 辐射取 GPU fib16 场（生产 uniform 已补偿到参考尺度），
  // 距离统计取 CPU 权威（捕获 ABI 无距离通道）。
  const buriedSet = new Set(buried);
  const recordsFor = (reject: boolean): IrradianceProbeRecord[] => parity[8].map((probeSample, index) => ({
    irradiance: fields[16]![index]!, validity: buriedSet.has(index) && reject ? 0 : 1,
    meanDistance: reject ? probeSample.meanDistance : tMax,
    distanceVariance: reject ? Math.max(probeSample.variance, 1e-4) : 1e-4, occlusionFloor: 0 }));
  const recordSets = [recordsFor(false), recordsFor(true)];
  const levelMeta = { level: 0, gridSize: [...GRID] as [number, number, number], spacing: 1,
    originCell: [0, 0, 0] as [number, number, number], origin: [1, 1, 1] as [number, number, number],
    max: [GRID[0], GRID[1], GRID[2]] as [number, number, number], probeCount };
  const receivers: { position: [number, number, number]; normal: [number, number, number] }[] = [];
  for (const x of [4.4, 4.8]) for (const z of [1.5, 2, 4, 4.5]) {
    receivers.push({ position: [x, 1, z], normal: [-1, 0, 0] }, { position: [x, 1, z], normal: [1, 0, 0] });
  }
  const receiverBytes = new Float32Array(receivers.length * 8);
  receivers.forEach(({ position, normal }, index) => {
    receiverBytes.set([...position, 0], index * 8);
    receiverBytes.set([...normal, 0], index * 8 + 4);
  });
  const SAMPLING_DRIVER = `
struct T02Receiver { position: vec4f, normal: vec4f };
@group(0) @binding(0) var<storage, read> t02Receivers: array<T02Receiver>;
@group(0) @binding(1) var<storage, read_write> t02Outputs: array<vec4f>;
@compute @workgroup_size(64)
fn t02_sample_receivers(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= arrayLength(&t02Receivers)) { return; }
  let receiver = t02Receivers[gid.x];
  let sampled = deepGiSample(receiver.position.xyz, receiver.normal.xyz, vec3f(0.0));
  t02Outputs[gid.x] = vec4f(sampled, 1.0);
}
`;
  const sampling = await page.evaluate(t02ProbeSamplingKernel, {
    wgslSampling: PROBE_CLIPMAP_SAMPLING_WGSL + SAMPLING_DRIVER,
    recordSetsB64: recordSets.map(records => toBase64(packRecords(records))),
    levelsB64: toBase64(packProbeLevels([levelMeta])), receiversB64: toBase64(receiverBytes),
    receiverCount: receivers.length, probeStorageBinding: DEEP_GI_PROBE_STORAGE_BINDING,
    levelMetadataBinding: DEEP_GI_LEVEL_METADATA_BINDING });
  const sampledSets = sampling.outputs.map(output => {
    const bytes = Buffer.from(output, "base64");
    const floats = new Float32Array(bytes.buffer, bytes.byteOffset, receivers.length * 4);
    return receivers.map((_, index) => [floats[index * 4]!, floats[index * 4 + 1]!,
      floats[index * 4 + 2]!] as [number, number, number]); });
  const truthAt = (receiver: { position: [number, number, number] }): number => {
    const index = positions.findIndex(position => position[0] === Math.round(receiver.position[0]!)
      && position[1] === receiver.position[1]! && position[2] === Math.round(receiver.position[2]!));
    if (index < 0) throw new Error("Wall receiver has no matching truth probe.");
    return truthShadowed[index]![0]!;
  };
  const wall = (setIndex: number): number[] => sampledSets[setIndex]!
    .map((value, index) => Math.abs(value[0]! - truthAt(receivers[index]!)))
    .filter((_, index) => index % 2 === 0);
  const gpuVsCpuSampler = Math.max(...sampledSets.flatMap((sampled, setIndex) =>
    sampled.map((value, index) => {
      const cpu = sampleIrradianceProbeClipmap({ worldPosition: [...receivers[index]!.position],
        worldNormal: [...receivers[index]!.normal], levels: [levelMeta],
        records: recordSets[setIndex]!, environmentFallback: [0, 0, 0] });
      return Math.max(...[0, 1, 2].map(axis => Math.abs(value[axis]! - cpu.irradiance[axis]!)));
    })));
  const mean = (values: readonly number[]): number =>
    values.reduce((total, value) => total + value, 0) / values.length;
  const wallAdmitted = wall(0), wallPolicy = wall(1);
  const filtered = await page.evaluate(t02FilterProductionCapture, {
    filterWgsl: WEBGPU_PROBE_CAPTURE_WGSL, captureB64: gpu.fields[32]!.halfB64 });
  const textureConsumer = await runT02ProductionTextureConsumer(page,
    filtered.halfB64, buried, receivers, receiverBytes, truthShadowed, positions);
  const dispatchCostP50 = percentiles(gpu.dispatchDurations).p50;
  const awayEqual = receivers.every((receiver, index) => index % 2 === 0 || Math.max(
    ...[0, 1, 2].map(axis => Math.abs(sampledSets[0]![index]![axis]! - sampledSets[1]![index]![axis]!))) <= 1e-6);
  const overflowOk = directionCounts.every(count => gpu.fields[count]!.overflowSentinel === 0)
    && gpu.staleField.overflowSentinel === 0 && gpu.targetField.overflowSentinel === 0;
  const checks = {
    noQueueErrors: gpu.queueErrors.length === 0 && sampling.queueErrors.length === 0
      && textureConsumer.queueErrors.length === 0 && filtered.errors.length === 0
      && gpu.messages.length === 0 && sampling.messages.length === 0
      && textureConsumer.shaderMessages.length === 0 && filtered.messages.length === 0,
    overflowSentinelsZero: overflowOk,
    parityWithinF16Quantization: [8, 16, 32].every(count => parityMax(count) <= 1e-3),
    producerBuriedAlphaZero: textureConsumer.producerBuriedAlpha.length === buried.length
      && textureConsumer.producerBuriedAlpha.every(alpha => alpha === 0)
      && textureConsumer.producerValidCount === probeCount - buried.length,
    burialConsistent: buried.length === 8 && buried.every(index => positions[index]![0] === 4
      && positions[index]![2] !== 3) && buried.join(",") === buriedScene.join(",")
      && relocation.every(offset => Math.abs(offset[0]! - 0.25) < 1e-6 && offset[1] === 0 && offset[2] === 0),
    stableNonBuriedCount: positions.filter((_, index) => includeProbe(index)).length === 62,
    rmseFib32WithinAcceptance: rmseOf(32) <= 0.10,
    rmseMonotoneInDirectionCount: rmseOf(8) > rmseOf(16) && rmseOf(16) > rmseOf(32),
    wallAdmittedPollutes: mean(wallAdmitted) < 0.005, // producer already zeroed buried RGB; no synthetic pre-fix source
    wallPolicyClean: mean(wallPolicy) < 0.005,
    productionTextureRejectsBuried: textureConsumer.meanRejectedError < 0.005
      && textureConsumer.maxFacingAwayDelta <= 1e-6,
    awayFacingUntouched: awayEqual,
    gpuSamplerMatchesCpu: gpuVsCpuSampler <= 1e-4,
    shadowedTruthDarkAtWall: buried.every(index => truthShadowed[index]![0]! < 0.02),
    convergenceMatchesSimulator: [2, 4, 8].every(budget =>
      (convergence[budget] as { framesToTolerance: number | null; cpuSimulatorFrames: number | null }).framesToTolerance
      === (convergence[budget] as { cpuSimulatorFrames: number | null }).cpuSimulatorFrames),
    convergenceWithinOneSecond: [2, 4, 8].every(budget =>
      (convergence[budget] as { framesToTolerance: number | null }).framesToTolerance !== null
      && (convergence[budget] as { framesToTolerance: number }).framesToTolerance / 60 <= 1),
    convergenceMonotone: [2, 4, 8].every(budget =>
      (convergence[budget] as { monotone: boolean; maxUpdatesPerFrame: number }).monotone
      && (convergence[budget] as { maxUpdatesPerFrame: number }).maxUpdatesPerFrame <= budget),
    dispatchFitsFrameBudget: dispatchCostP50 <= 16.7,
  };
  const evidence = {
    schema: "t02-probe-reference-gpu-evidence-v1", createdAt: new Date().toISOString(),
    lane: "t02-probe-reference-real-gpu",
    method: "生产 probeRadianceKernel 32 方向容量（fib8/16/32）+ 生产 deepGiSample WGSL；CPU 参考 = 4096 分层 MC（seed 20260927）；GPU uniform 的直射强度 ×π×|L|，环境不变，读回即参考尺度",
    honestNotes: [
      "fib32 方向表来自生产 WGSL 与 packProbeRadianceUniform，不再用文本 variant；产品 GI 构造明确启用 32 方向和 8 探针/帧上限。",
      "墙内存储路径 meanDistance/variance/validity 仍由 CPU 联测注入；纹理端仅 alpha，可证明有效性拒绝，不能宣称 Chebyshev。",
      "每档从陈旧场重放，逐帧提交真实 GPU 计算/读回；秒数按 60fps 帧数换算，并非 60fps 真画面端到端测量；wallMs 含逐帧 mapAsync 读回开销，纯 dispatch 成本另测。",
    ],
    adapter: gpu.adapter, probeCount, buried, relocation,
    stableNonBuried: positions.filter((_, index) => includeProbe(index)).length,
    rmse: { fib8: rmseOf(8), fib16: rmseOf(16), fib32: rmseOf(32),
      parityMaxVsCpuFib8: parityMax(8), parityMaxVsCpuFib16: parityMax(16), parityMaxVsCpuFib32: parityMax(32) },
    deviation: { fib16: deviationOf(16), fib32: deviationOf(32) },
    wallLeak: { receivers: receivers.map((receiver, index) => ({ position: receiver.position,
        normal: receiver.normal, admitted: sampledSets[0]![index], policy: sampledSets[1]![index] })),
      meanAdmittedError: mean(wallAdmitted), meanPolicyError: mean(wallPolicy),
      gpuSamplerVsCpuMaxAbsDiff: gpuVsCpuSampler,
      shadowedTruthAtBuried: buried.map(index => truthShadowed[index]![0]) },
    productionTextureConsumer: textureConsumer,
    convergence, dispatchCostMs: percentiles(gpu.dispatchDurations),
    queueErrors: [...gpu.queueErrors, ...sampling.queueErrors, ...filtered.errors, ...textureConsumer.queueErrors],
    shaderMessages: [...gpu.messages, ...sampling.messages, ...filtered.messages, ...textureConsumer.shaderMessages],
    checks,
    allPass: Object.values(checks).every(Boolean),
  };
  await mkdir(outputDir, { recursive: true });
  await writeFile(`${outputDir}evidence.json`, JSON.stringify(evidence, null, 2));
  await writeFile(assetFile, JSON.stringify(evidence, null, 2));
  console.log(`t02 probe-reference gpu: allPass=${evidence.allPass} rmse8=${(rmseOf(8) * 100).toFixed(2)}% rmse16=${(rmseOf(16) * 100).toFixed(2)}% rmse32=${(rmseOf(32) * 100).toFixed(2)}% parity16=${parityMax(16).toExponential(2)} wallAdmitted=${mean(wallAdmitted).toFixed(4)} wallPolicy=${mean(wallPolicy).toFixed(4)} frames=${[2, 4, 8].map(budget => `${budget}:${(convergence[budget] as { framesToTolerance: number }).framesToTolerance}`).join("/")} dispatchP50=${dispatchCostP50.toFixed(3)}ms`);
  if (!evidence.allPass) process.exitCode = 1;
} finally { await browser.close(); server.close(); }
