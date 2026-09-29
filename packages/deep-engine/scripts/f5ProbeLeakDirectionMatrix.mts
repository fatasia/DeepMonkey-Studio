import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { computeNormalizedFieldRmse } from "../src/lighting/probeInvalidationConvergence.js";
import { sampleIrradianceProbeClipmap, type IrradianceProbeRecord } from "../src/lighting/probeClipmapSampling.js";
import { packProbeLevels } from "../src/lighting/probeClipmapResourceData.js";
import { PROBE_CLIPMAP_SAMPLING_WGSL, DEEP_GI_PROBE_STORAGE_BINDING,
  DEEP_GI_LEVEL_METADATA_BINDING } from "../src/lighting/probeClipmapSamplingWgsl.ts";
import { assembleLeakMatrixRow, buildWallLeakReceivers, probeIndexForReceiver,
  referenceLitScaleIR, summarizeLeakMatrix } from "../src/lighting/probeLeakDirectionMatrix.js";
import type { ProbeVector3 } from "../src/lighting/probeClipmapPlan.js";
import { emitProbeRadianceKernelWgsl } from "../src/rayTracing/probeRadianceKernel.ts";
import { t02ProbeFieldKernel, t02ProbeSamplingKernel } from "./t02ProbePageKernel.mjs";
import { t02FilterProductionCapture } from "./t02ProbeTextureSamplingPageKernel.mjs";
import { WEBGPU_PROBE_CAPTURE_WGSL } from "../src/webgpu/webgpuProbeCaptureWgsl.ts";
import { runT02ProductionTextureConsumer } from "./t02ProbeTextureConsumer.mts";
import { prepareT02ProbeJoint, packUniform, packProbeParams, packRecords, decodeProbeField,
  toBase64, GRID, directionCounts, PROBE_PARAM_BYTES, CAPTURE_BYTES_PER_ROW,
  CAPTURE_BUFFER_BYTES } from "./t02ProbePrep.mts";

// F5 漏光 × 方向数真机矩阵（headless Chrome + 真机 WebGPU；harness 沿用 t02 联测证据链）。
// 任务缺口：历史污染测量口径分裂（CPU slab fib8 / GPU 存储注入 fib16 / GPU 纹理 fib32），
// 没有**同口径**的 8/16/32 漏光对照。本脚本在生产 WGSL 下一次性补齐：
//   存储记录路径（CPU 注入 validity/距离统计，Chebyshev 可测）+ 生产纹理路径
//   （deepGiSampleTexture，仅 alpha 有效性），每方向档各出「反事实 vs 策略现实」对照。
// 指标定义单一来源 = src/lighting/probeLeakDirectionMatrix.ts（与 CPU 单测同尺）。
// 诚实边界：本脚本无 UI/画面产出，验收口径是数值污染/漏光率；视觉闭环不适用。

const require = createRequire(import.meta.url);
const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
const outputDir = fileURLToPath(new URL("../../../test-output/deep-core/F5/probe-leak-direction-matrix-r1/", import.meta.url));
const assetFile = fileURLToPath(new URL("../../../docs/reports/deep-core/assets/f5-probe-leak-direction-matrix-2026-09-29.json", import.meta.url));

const prep = prepareT02ProbeJoint();
const { scene, packet, rayScene, packed, positions, parity, buried, mcField, includeProbe,
  truthShadowed } = prep;
const probeCount = positions.length;
const receivers = buildWallLeakReceivers();
const truthRed = receivers.map(receiver => truthShadowed[probeIndexForReceiver(receiver, positions)]![0]!);
const litScale = referenceLitScaleIR(positions.map((_, index) => index)
  .filter(includeProbe).map(index => parity[8]![index]!.irradiance[0]!));
const receiverBytes = new Float32Array(receivers.length * 8);
receivers.forEach(({ position, normal }, index) => {
  receiverBytes.set([...position, 0], index * 8);
  receiverBytes.set([...normal, 0], index * 8 + 4);
});
const productionWgsl = emitProbeRadianceKernelWgsl();
const frames = buildLeakFrames();
function buildLeakFrames() {
  // 页内核固定会跑逐帧收敛段：给最小 8/帧批次满足其载荷合同，本脚本不消费该段。
  return [{ budget: 8, batch: positions.map((_, index) => index).slice(0, 8),
    uniformB64: toBase64(packUniform(scene, 8, 2, 32)),
    paramsB64: toBase64(packProbeParams(positions, positions.map((_, index) => index).slice(0, 8))) }];
}

const SAMPLING_DRIVER = `
struct F5Receiver { position: vec4f, normal: vec4f };
@group(0) @binding(0) var<storage, read> f5Receivers: array<F5Receiver>;
@group(0) @binding(1) var<storage, read_write> f5Outputs: array<vec4f>;
@compute @workgroup_size(64)
fn t02_sample_receivers(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= arrayLength(&f5Receivers)) { return; }
  let receiver = f5Receivers[gid.x];
  let sampled = deepGiSample(receiver.position.xyz, receiver.normal.xyz, vec3f(0.0));
  f5Outputs[gid.x] = vec4f(sampled, 1.0);
}
`;
const levelMeta = { level: 0, gridSize: [...GRID] as [number, number, number], spacing: 1,
  originCell: [0, 0, 0] as [number, number, number], origin: [1, 1, 1] as [number, number, number],
  max: [GRID[0], GRID[1], GRID[2]] as [number, number, number], probeCount };
const buriedSet = new Set(buried);
// 存储路径两策略（与 CPU 单测逐位同语义）：
// 反事实 preFix = parity CPU 权威亮源 + validity=1 + 盲距离（「若无墙内策略」）；
// 策略现实 policy = 生产 GPU 捕获（埋入 RGB 已清零）+ validity=0 + 真实距离统计。
const storageRecords = (count: number, policy: boolean): IrradianceProbeRecord[] =>
  parity[count]!.map((probeSample, index) => {
    const isBuried = buriedSet.has(index);
    if (policy && isBuried) {
      return { irradiance: [0, 0, 0], validity: 0, meanDistance: probeSample.meanDistance,
        distanceVariance: Math.max(probeSample.variance, 1e-4), occlusionFloor: 0 };
    }
    return { irradiance: probeSample.irradiance, validity: 1,
      meanDistance: policy ? probeSample.meanDistance : prep.tMax,
      distanceVariance: policy ? Math.max(probeSample.variance, 1e-4) : 1e-4, occlusionFloor: 0 };
  });

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
    timing: { warmup: 5, samples: 10,
      uniformB64: toBase64(packUniform(scene, 8, 2, 32)),
      paramsB64: toBase64(packProbeParams(positions, frames[0]!.batch)) } });
  const fields = Object.fromEntries(Object.entries(gpu.fields).map(([count, field]) =>
    [count, decodeProbeField(Buffer.from(field.halfB64, "base64"), probeCount)]));
  const rmseOf = (count: number): number => computeNormalizedFieldRmse(fields[count]!, mcField,
    positions.map((_, index) => index).filter(includeProbe));

  // 存储记录路径：6 组记录（3 方向档 × 反事实/策略）一次注入采样。
  const recordSets = directionCounts.flatMap(count => [storageRecords(count, false), storageRecords(count, true)]);
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
  const gpuVsCpuSampler = Math.max(...sampledSets.flatMap((sampled, setIndex) =>
    sampled.map((value, index) => {
      const cpu = sampleIrradianceProbeClipmap({ worldPosition: receivers[index]!.position,
        worldNormal: receivers[index]!.normal, levels: [levelMeta], records: recordSets[setIndex]!,
        environmentFallback: [0, 0, 0] });
      return Math.max(...[0, 1, 2].map(axis => Math.abs(value[axis]! - cpu.irradiance[axis]!)));
    })));

  const rows = directionCounts.map((count, order) => assembleLeakMatrixRow({
    directionCount: count,
    preFixSampled: sampledSets[order * 2]!, policySampled: sampledSets[order * 2 + 1]!,
    truthRedByReceiver: truthRed, litScale, receivers }));
  const summary = summarizeLeakMatrix(rows);

  // 生产纹理路径（deepGiSampleTexture，仅 alpha）：每方向档独立过生产捕获滤波。
  type TextureConsumer = Awaited<ReturnType<typeof runT02ProductionTextureConsumer>>;
  const textureConsumers: Partial<Record<number, TextureConsumer>> = {};
  for (const count of directionCounts) {
    const filtered = await page.evaluate(t02FilterProductionCapture, {
      filterWgsl: WEBGPU_PROBE_CAPTURE_WGSL, captureB64: gpu.fields[count]!.halfB64 });
    textureConsumers[count] = await runT02ProductionTextureConsumer(page, filtered.halfB64,
      buried, receivers, receiverBytes, truthShadowed, positions);
  }

  const alphaOk = directionCounts.every(count => {
    const consumer = textureConsumers[count]!;
    return consumer.producerBuriedAlpha.length === buried.length
      && consumer.producerBuriedAlpha.every(alpha => alpha === 0)
      && consumer.producerValidCount === probeCount - buried.length; });
  const checks = {
    noQueueErrors: gpu.queueErrors.length === 0 && sampling.queueErrors.length === 0
      && directionCounts.every(count => textureConsumers[count]!.queueErrors.length === 0),
    noShaderMessages: gpu.messages.length === 0 && sampling.messages.length === 0
      && directionCounts.every(count => textureConsumers[count]!.shaderMessages.length === 0),
    overflowSentinelsZero: directionCounts.every(count => gpu.fields[count]!.overflowSentinel === 0),
    rmseContextMatchesSequence: rmseOf(8) > rmseOf(16) && rmseOf(16) > rmseOf(32) && rmseOf(32) <= 0.10,
    storagePreFixPollutionAtAllCounts: summary.preFixPollutionAtAllCounts,
    storagePolicyWithinGate: summary.policyWithinGateAtAllCounts,
    storageReductionAtEveryCount: summary.reductionAtEveryCount,
    storageFacingAwayUntouched: summary.facingAwayUntouched,
    gpuSamplerMatchesCpu: gpuVsCpuSampler <= 1e-4,
    producerBurialDirectionRobust: alphaOk,
    textureRejectedWithinGate: directionCounts.every(count =>
      textureConsumers[count]!.meanRejectedError <= 0.005),
    litScaleSane: litScale > 0 && Number.isFinite(litScale),
  };
  const evidence = {
    schema: "f5-probe-leak-direction-matrix-evidence-v1", createdAt: new Date().toISOString(),
    lane: "f5-probe-leak-direction-real-gpu",
    method: "生产 probeRadianceKernel（fib8/16/32 全场捕获）+ 生产 deepGiSample / deepGiSampleTexture；"
      + "指标定义单一来源 src/lighting/probeLeakDirectionMatrix.ts（与 CPU 单测同尺）；"
      + "漏光率 = 朝墙接收点污染 / 稳定探针亮室尺度（parity[8] 红通道均值）",
    honestNotes: [
      "preFix 反事实 = CPU parity 亮源注入 validity=1 + 盲距离（生产从不发布该组合）；"
        + "policy 现实 = 生产捕获（埋入 RGB 由 producer 清零）+ CPU 注入 validity/距离统计。",
      "纹理 ABI 无距离/方差通道，纹理路径只能证明 alpha 拒绝，不能宣称 Chebyshev；"
        + "meanRejectedError 的反事实把 alpha 全置 1，但 RGB 已清零，不等价于旧 producer 亮斑。",
      "litScale 取 RenderPacket 路径 parity[8] 稳定探针红通道均值，与 CPU slab 单测的 0.1903 "
        + "存在三角化微差，两侧漏光率各自用本链尺度归一。",
      "数值读回不能代替产品画面截图/视觉验收。",
    ],
    adapter: gpu.adapter, probeCount, buried, stableNonBuried: positions.map((_, index) => index).filter(includeProbe).length,
    litScale, rmseContext: { fib8: rmseOf(8), fib16: rmseOf(16), fib32: rmseOf(32) },
    storageMatrix: summary, gpuSamplerVsCpuMaxAbsDiff: gpuVsCpuSampler,
    textureConsumers: Object.fromEntries(directionCounts.map(count => [count, {
      meanAdmittedError: textureConsumers[count]!.meanAdmittedError,
      meanRejectedError: textureConsumers[count]!.meanRejectedError,
      maxFacingAwayDelta: textureConsumers[count]!.maxFacingAwayDelta,
      producerBuriedAlpha: textureConsumers[count]!.producerBuriedAlpha,
      producerValidCount: textureConsumers[count]!.producerValidCount }])),
    queueErrors: [...gpu.queueErrors, ...sampling.queueErrors,
      ...directionCounts.flatMap(count => textureConsumers[count]!.queueErrors)],
    shaderMessages: [...gpu.messages, ...sampling.messages,
      ...directionCounts.flatMap(count => textureConsumers[count]!.shaderMessages)],
    checks, allPass: Object.values(checks).every(Boolean) };
  await mkdir(outputDir, { recursive: true });
  await writeFile(`${outputDir}evidence.json`, JSON.stringify(evidence, null, 2));
  await writeFile(assetFile, JSON.stringify(evidence, null, 2));
  console.log(`f5 leak matrix: allPass=${evidence.allPass} litScale=${litScale.toFixed(4)} `
    + `storage=[${rows.map(row => `fib${row.directionCount} preFix=${row.preFixMeanError.toFixed(5)}`
      + `(${(row.preFixLeakRate * 100).toFixed(2)}%) policy=${row.policyMeanError.toFixed(6)}`
      + `(${(row.policyLeakRate * 100).toFixed(4)}%) x${row.reductionFactor.toFixed(0)}`).join(" | ")}] `
    + `texture=[${directionCounts.map(count => `fib${count} rejected=`
      + `${textureConsumers[count]!.meanRejectedError.toFixed(6)}`).join(" | ")}] `
    + `rmse=[${[8, 16, 32].map(count => `${count}:${(rmseOf(count) * 100).toFixed(2)}%`).join("/")}]`);
  if (!evidence.allPass) process.exitCode = 1;
} finally { await browser.close(); server.close(); }
