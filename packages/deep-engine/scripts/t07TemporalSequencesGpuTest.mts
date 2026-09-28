import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { TEMPORAL_AA_WGSL } from "../src/postprocess/temporalAaWgsl.ts";
import { buildAllSequences, buildFenceSequence, buildMovingCharacterSequence } from "../src/postprocess/temporalSequenceScenes.ts";
import { analyticMotion } from "../src/postprocess/temporalMotionReference.ts";
import { resolveTemporalAaCpu, temporalAaJitter } from "../src/postprocess/temporalAaCpu.ts";
import { accumulateTemporalFrameDetailed, GHOST_GUARD_REPROJECTION_POLICY, measureGhostSequence } from "../src/postprocess/temporalReprojection.ts";
import { internalResolutionReport, DynamicResolutionScaler } from "../src/postprocess/resolutionScaler.ts";
import { ssrRegionSsim } from "../src/postprocess/screenSpaceReflectionQuality.ts";
import { t07TemporalPageKernel } from "./t07TemporalGpuPageKernel.mjs";
import { t07TemporalCostKernel } from "./t07TemporalCostKernel.mjs";
import { MOTION_WGSL, UPSAMPLE_WGSL } from "./t07TemporalKernelsWgsl.mjs";
import { base64, toF16RgbaBytes, f32Buffer, percentiles, extractRgba, extractMotion,
  maxAbsDiff, hasNonFinite, edgePixelCount, toRgb } from "./t07TemporalCodec.mts";

// T07 四类序列实机 GPU 采集(headless Chrome + 真机 GPU,复用 T03/T05 采集模式)。
// 判定:①MV 逐像素对拍(f16 读回容差);②GPU 基线 TAA 与 CPU 镜像 parity;
// ③残影能量 3 帧 <5%(ghost-guard 决策内核 = 生产 WGSL + temporalReprojection 同式决策注入);
// ④reactive mask 带内外行为与 CPU 同族公式一致;⑤67% 模式画质(SSIM+边缘保持)与
// GPU 节省(帧时戳)双数据。禁只报 FPS。

const require = createRequire(import.meta.url);
const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
const outputDir = fileURLToPath(new URL("../../../test-output/deep-core/T07/temporal-sequences-gpu-r1/", import.meta.url));

const OPTIONS = { feedback: 0.9, depthThreshold: 0.012, relativeDepthThreshold: 0.02 };
const MASK_ROWS: readonly [number, number] = [0.3, 0.45], MASK_COVERAGE = 128;
const MV_TOLERANCE_UV = 1.5e-3, TAA_PARITY_TOLERANCE = 0.02, FRAME_PARITY_TOLERANCE = 5e-3;


/** 生产 TAA WGSL + ghost-guard 决策注入(与 temporalReprojection.GHOST_GUARD 同式);生产体漂移则 fail-fast。 */
function deriveGuardWgsl(): string {
  const anchor = "resolved = mix(color.rgb, clampedHistory, temporalParams.tuning.x * (1.0 - reactive));";
  if (!TEMPORAL_AA_WGSL.includes(anchor)) throw new Error("Production TAA WGSL drifted; ghost-guard injection anchor missing.");
  const body = `{
        // T07 decision layer (mirrors postprocess/temporalReprojection.ts GHOST_GUARD_REPROJECTION_POLICY):
        // acceptedRatio < 0.25 -> 3x3 neighborhood box fallback; mean clamped-history error > 0.05 -> decay feedback x0.35.
        let acceptedRatio = historicalColor.a;
        if (acceptedRatio < 0.25) {
          var boxMean = vec3f(0.0);
          for (var oy = -1; oy <= 1; oy++) { for (var ox = -1; ox <= 1; ox++) {
            let neighbor = clamp(coordinate + vec2<i32>(ox, oy), vec2<i32>(0), vec2<i32>(size) - 1);
            boxMean = boxMean + textureLoad(currentColor, neighbor, 0).rgb / 9.0;
          } }
          resolved = max(boxMean, vec3f(0.0));
        } else {
          let historyError = dot(abs(clampedHistory - color.rgb), vec3f(1.0)) / 3.0;
          var feedback = temporalParams.tuning.x * (1.0 - reactive);
          if (historyError > 0.05) { feedback = feedback * 0.35; }
          resolved = mix(color.rgb, clampedHistory, feedback);
        }
      }`;
  return TEMPORAL_AA_WGSL.replace(anchor, body);
}

const buildMask = (width: number, height: number): Uint8Array => {
  const mask = new Uint8Array(width * height);
  for (let y = Math.floor(height * MASK_ROWS[0]); y < Math.floor(height * MASK_ROWS[1]); y++)
    for (let x = 0; x < width; x++) mask[y * width + x] = MASK_COVERAGE;
  return mask;
};

type SequenceLike = ReturnType<typeof buildFenceSequence>;
const packFramePayload = (sequenceArg: SequenceLike) =>
  sequenceArg.frames.map((frame, index) => {
    const currentJitter = temporalAaJitter(index), previousJitter = temporalAaJitter(Math.max(0, index - 1));
    const rows = new Float32Array(sequenceArg.frames[index]!.relativeRows.length * 12);
    frame.relativeRows.forEach((rowGroup, object) => rows.set([...rowGroup[0], ...rowGroup[1], ...rowGroup[2]], object * 12));
    const matrices = new Float32Array(40);
    matrices.set([...frame.viewProjection], 0);
    matrices.set([...frame.previousViewProjection], 16);
    const jitterDeltaUv: [number, number] = [(previousJitter[0] - currentJitter[0]) / sequenceArg.width, (previousJitter[1] - currentJitter[1]) / sequenceArg.height];
    matrices.set([jitterDeltaUv[0], jitterDeltaUv[1], 0, 0], 32);
    matrices.set([sequenceArg.width, sequenceArg.height, frame.relativeRows.length, 0], 36);
    return { colorB64: base64(toF16RgbaBytes(frame.color)), depthB64: base64(f32Buffer(frame.depth)),
      worldB64: base64(f32Buffer(frame.world)), rowsB64: base64(new Uint8Array(rows.buffer)),
      matricesB64: base64(new Uint8Array(matrices.buffer)), historyValid: index > 0,
      jitterCur: currentJitter, jitterPrev: previousJitter, jitterDeltaUv };
  });

/** CPU 参考链(与 GPU 同输入:GPU 读回的 f16 运动场)。 */
function cpuChain(width: number, height: number, framesPayload: ReturnType<typeof packFramePayload>,
  gpuMotion: readonly Float32Array[], variant: "baseline" | "guard" | "masked",
  sequenceArg: SequenceLike): Float32Array[] {
  const resolved: Float32Array[] = [];
  let previousColor: Float32Array | undefined, previousDepth: Float32Array | undefined;
  const reactiveMask = variant === "masked" ? Array.from(buildMask(width, height)) : undefined;
  framesPayload.forEach((frame, index) => {
    const historyValid = frame.historyValid;
    const input = { width, height, color: Array.from(sequenceArg.frames[index]!.color), depth: Array.from(sequenceArg.frames[index]!.depth),
      motion: Array.from(gpuMotion[index]!), ...(historyValid ? { previousColor: Array.from(previousColor!), previousDepth: Array.from(previousDepth!) } : {}),
      currentJitter: frame.jitterCur, previousJitter: frame.jitterPrev, historyValid,
      ...(reactiveMask ? { reactiveMask } : {}) };
    const output = variant === "guard"
      ? accumulateTemporalFrameDetailed(input, OPTIONS, GHOST_GUARD_REPROJECTION_POLICY).output
      : resolveTemporalAaCpu(input, OPTIONS);
    resolved.push(output);
    previousColor = output; previousDepth = sequenceArg.frames[index]!.depth;
  });
  return resolved;
}

const server = createServer((_request, response) => response.writeHead(200, { "content-type": "text/html" })
  .end("<html><body style=\"background:#101820\"></body></html>"));
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true, args: ["--enable-unsafe-webgpu"] });
await mkdir(outputDir, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(`http://127.0.0.1:${port}`);
  const guardWgsl = deriveGuardWgsl();
  const sequences = buildAllSequences();
  const cases: Record<string, unknown>[] = [];
  const rawTimings: Record<string, number[]> = {};
  const qualityCases: Record<string, unknown>[] = [];
  for (const sequenceArg of sequences) {
    const framesPayload = packFramePayload(sequenceArg);
    const maskB64 = sequenceArg.name === "moving-character" ? base64(buildMask(sequenceArg.width, sequenceArg.height)) : undefined;
    const gpu = await page.evaluate(t07TemporalPageKernel, { mode: "sequence", width: sequenceArg.width, height: sequenceArg.height,
      frames: framesPayload, options: OPTIONS, wgslTaa: TEMPORAL_AA_WGSL, wgslGuard: guardWgsl, wgslMotion: MOTION_WGSL, wgslUpsample: UPSAMPLE_WGSL,
      ...(maskB64 ? { maskB64 } : {}) });
    if (gpu.queueErrors.length) throw new Error(`${sequenceArg.name}: queue errors: ${gpu.queueErrors.join("; ")}`);
    const { width, height } = sequenceArg;
    const gpuMotion = gpu.motionFrames.map((frameB64: string) => extractMotion(Buffer.from(frameB64, "base64"), width, height, gpu.rowStride.motion));
    const gpuBaseline = gpu.baselineFrames.map((frameB64: string) => extractRgba(Buffer.from(frameB64, "base64"), width, height, gpu.rowStride.color));
    const gpuGuard = gpu.guardFrames.map((frameB64: string) => extractRgba(Buffer.from(frameB64, "base64"), width, height, gpu.rowStride.color));
    const cpuBaseline = cpuChain(width, height, framesPayload, gpuMotion, "baseline", sequenceArg);
    const cpuGuard = cpuChain(width, height, framesPayload, gpuMotion, "guard", sequenceArg);
    // MV 逐像素对拍(f64 解析 vs GPU f16 读回)。
    let maxUvError = 0, mismatchedPixels = 0;
    framesPayload.forEach((frame, index) => {
      const world = sequenceArg.frames[index]!.world;
      for (let pixel = 0; pixel < width * height; pixel++) {
        const objectId = world[pixel * 4 + 3]!;
        const worldPoint = [world[pixel * 4]!, world[pixel * 4 + 1]!, world[pixel * 4 + 2]!];
        const rows = objectId >= 1 ? sequenceArg.frames[index]!.relativeRows[objectId - 1]! : [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] as const;
        const expected = analyticMotion({ currentViewProjection: sequenceArg.frames[index]!.viewProjection,
          previousViewProjection: sequenceArg.frames[index]!.previousViewProjection, jitterDeltaUv: frame.jitterDeltaUv,
          modelPoint: worldPoint, currentRows: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] as const, previousRows: rows as never });
        const actualX = gpuMotion[index]![pixel * 2]!, actualY = gpuMotion[index]![pixel * 2 + 1]!;
        const error = Math.hypot(expected[0] - actualX, expected[1] - actualY);
        maxUvError = Math.max(maxUvError, error);
        if (error > MV_TOLERANCE_UV) mismatchedPixels++;
      }
    });
    const ideals = sequenceArg.frames.map(frame => frame.color);
    const ghostBaseline = measureGhostSequence(gpuBaseline.slice(sequenceArg.moveFrames), ideals.slice(sequenceArg.moveFrames), sequenceArg.sourceContrast);
    const ghostGuard = measureGhostSequence(gpuGuard.slice(sequenceArg.moveFrames), ideals.slice(sequenceArg.moveFrames), sequenceArg.sourceContrast);
    const ghostCpuGuard = measureGhostSequence(cpuGuard.slice(sequenceArg.moveFrames), ideals.slice(sequenceArg.moveFrames), sequenceArg.sourceContrast);
    const parityFrames = cpuBaseline.map((frame, index) => maxAbsDiff(frame, gpuBaseline[index]));
    const integrityOk = [...gpuBaseline, ...gpuGuard, ...gpuMotion].every(values => !hasNonFinite(values));
    let maskedReport: Record<string, unknown> | undefined;
    if (gpu.maskedFrames) {
      const gpuMasked = gpu.maskedFrames.map((frameB64: string) => extractRgba(Buffer.from(frameB64, "base64"), width, height, gpu.rowStride.color));
      const cpuMasked = cpuChain(width, height, framesPayload, gpuMotion, "masked", sequenceArg);
      let bandMaxDiff = 0, outsideMaxDiff = 0;
      // 带边界 ±3 行是双线性历史 tap 的跨带过渡区(掩码邻域效应,物理正确),不计入带外。
      const bandStart = Math.floor(height * MASK_ROWS[0]), bandEnd = Math.floor(height * MASK_ROWS[1]);
      for (let index = 0; index < width * height; index++) {
        const row = Math.floor(index / width);
        const inBand = row >= bandStart && row < bandEnd;
        const inTransition = row >= bandStart - 3 && row < bandEnd + 3;
        const divergence = maxAbsDiff(Float32Array.from([gpuMasked[6]![index * 4]!, gpuMasked[6]![index * 4 + 1]!, gpuMasked[6]![index * 4 + 2]!, 1]),
          Float32Array.from([gpuBaseline[6]![index * 4]!, gpuBaseline[6]![index * 4 + 1]!, gpuBaseline[6]![index * 4 + 2]!, 1]));
        if (inBand) bandMaxDiff = Math.max(bandMaxDiff, divergence); else if (!inTransition) outsideMaxDiff = Math.max(outsideMaxDiff, divergence);
      }
      const maskedParity = cpuMasked.reduce((maxValue, frame, index) => Math.max(maxValue, maxAbsDiff(frame, gpuMasked[index]!)), 0);
      maskedReport = { maskedVsCpuMaxDiff: Number(maskedParity.toPrecision(3)),
        bandMaxDivergenceVsUnmasked: Number(bandMaxDiff.toPrecision(3)),
        outsideBandMaxDivergence: Number(outsideMaxDiff.toPrecision(3)),
        coverage: MASK_COVERAGE, expectedFeedbackFactor: Number((1 - MASK_COVERAGE / 255).toFixed(4)),
        pass: maskedParity < FRAME_PARITY_TOLERANCE && outsideMaxDiff < FRAME_PARITY_TOLERANCE && bandMaxDiff > 0.01 };
    }
    const timed = percentiles(gpu.timedMs);
    rawTimings[sequenceArg.name] = gpu.timedMs;
    const checks = { integrityOk, mvParity: mismatchedPixels === 0,
      gpuGuardPasses3Frames: ghostGuard.passesWithin3Frames,
      taaParity: Math.max(...parityFrames) < TAA_PARITY_TOLERANCE,
      maskPass: maskedReport ? maskedReport.pass === true : true,
      noQueueErrors: gpu.queueErrors.length === 0 };
    cases.push({ name: sequenceArg.name, description: sequenceArg.description, size: [width, height],
      moveFrames: sequenceArg.moveFrames, sourceContrast: Number(sequenceArg.sourceContrast.toFixed(4)),
      mvParity: { toleranceUv: MV_TOLERANCE_UV, maxUvError: Number(maxUvError.toExponential(3)), mismatchedPixels },
      taaParityMaxDiff: Number(Math.max(...parityFrames).toExponential(3)),
      ghost: { threshold: 0.05, gpuBaselineEnergies: ghostBaseline.energies.map(v => Number(v.toFixed(4))),
        gpuGuardEnergies: ghostGuard.energies.map(v => Number(v.toFixed(4))),
        cpuGuardEnergies: ghostCpuGuard.energies.map(v => Number(v.toFixed(4))),
        gpuGuardPassesWithin3Frames: ghostGuard.passesWithin3Frames, firstPassingFrame: ghostGuard.firstPassingFrame },
      reactiveMask: maskedReport, gpuCostMs: { ...timed, samples: gpu.timedMs.length }, checks,
      pass: Object.values(checks).every(Boolean) });
    console.log(`${sequenceArg.name}: pass=${(cases.at(-1) as { pass: boolean }).pass} mvMaxErr=${maxUvError.toExponential(2)} `
      + `ghostGuard[3f]=${ghostGuard.energies.map(v => v.toFixed(3)).join("/")} baseline[3f]=${ghostBaseline.energies.map(v => v.toFixed(3)).join("/")} p50=${timed.p50.toFixed(2)}ms`);
  }

  // 67% 画质:fence 与 character 各自 native 96 vs internal 64(+GPU 双线性上采样)。
  for (const build of [buildFenceSequence, buildMovingCharacterSequence]) {
    const native = build(96, 96), internal = build(64, 64);
    const gpu = await page.evaluate(t07TemporalPageKernel, { mode: "quality", width: 96, height: 96, internalWidth: 64, internalHeight: 64,
      frames: packFramePayload(native), internalFrames: packFramePayload(internal), options: OPTIONS,
      wgslTaa: TEMPORAL_AA_WGSL, wgslMotion: MOTION_WGSL, wgslUpsample: UPSAMPLE_WGSL });
    const nativeFinal = extractRgba(Buffer.from(gpu.nativeFinal, "base64"), 96, 96, gpu.rowStride.color);
    const upsampled = extractRgba(Buffer.from(gpu.upsampled, "base64"), 96, 96, gpu.rowStride.color);
    const ssim = ssrRegionSsim(toRgb(nativeFinal, 96, 96), toRgb(upsampled, 96, 96), 96, 96, { x0: 0, y0: 0, x1: 96, y1: 96 });
    const nativeEdges = edgePixelCount(toRgb(nativeFinal, 96, 96), 96, 96);
    const upsampledEdges = edgePixelCount(toRgb(upsampled, 96, 96), 96, 96);
    const report = internalResolutionReport(64 / 96, 96, 96, { ssim: Number(ssim.mean.toFixed(4)),
      edgeRetention: Number((upsampledEdges / Math.max(1, nativeEdges)).toFixed(4)), gpuCostRatio: -1,
      note: `t07 harness ${native.name}: native 96 TAA-final vs internal 64 + bilinear upsample` });
    qualityCases.push({ name: native.name, nativeEdges, upsampledEdges, ssim: Number(ssim.mean.toFixed(4)),
      pixelRatio: Number(report.pixelRatio.toFixed(4)), report });
    console.log(`quality ${native.name}: ssim=${ssim.mean.toFixed(4)} edgeRetention=${(upsampledEdges / Math.max(1, nativeEdges)).toFixed(3)}`);
  }

  // 67% 成本:fence 1024x576 全尺寸 vs 内部 686x386 + 上采样(帧时戳)。
  const costNative = buildFenceSequence(1024, 576), costInternal = buildFenceSequence(686, 386);
  const costReport = internalResolutionReport(0.67, 1024, 576);
  const gpuCost = await page.evaluate(t07TemporalCostKernel, { width: 1024, height: 576,
    internalWidth: costReport.internalWidth, internalHeight: costReport.internalHeight, internalScale: 0.67,
    colorB64: base64(toF16RgbaBytes(costNative.frames[7]!.color)), depthB64: base64(f32Buffer(costNative.frames[7]!.depth)),
    worldB64: base64(f32Buffer(costNative.frames[7]!.world)),
    rowsB64: base64(new Uint8Array(Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]).buffer)),
    matricesB64: base64(new Uint8Array(Float32Array.from([...costNative.frames[7]!.viewProjection, ...costNative.frames[7]!.previousViewProjection,
      0, 0, 0, 0, 1024, 576, 1, 0]).buffer)),
    internalColorB64: base64(toF16RgbaBytes(costInternal.frames[7]!.color)),
    internalDepthB64: base64(f32Buffer(costInternal.frames[7]!.depth)),
    options: OPTIONS, wgslTaa: TEMPORAL_AA_WGSL, wgslMotion: MOTION_WGSL, wgslUpsample: UPSAMPLE_WGSL,
    jitterCur: temporalAaJitter(7), jitterPrev: temporalAaJitter(7) });
  // 32 次重复归一后的单帧成本(见内核 REPEAT 注释)。
  const fullCost = percentiles(gpuCost.fullCostPerFrameMs), internalCost = percentiles(gpuCost.internalCostPerFrameMs);
  const resolveOnlyRatio = percentiles(gpuCost.resolveInternalPerFrameMs).p50 / Math.max(1e-6, percentiles(gpuCost.resolveFullPerFrameMs).p50);
  const costRatio = internalCost.p50 / Math.max(1e-6, fullCost.p50);
  // scaler 决策轨迹:实测帧时喂入(本探针远低于 16.67ms 目标带 → 顶格保持);
  // 合成过载序列仅演示决策表下降路径(决策表本身由单测覆盖),不代表真实负载。
  const scaler = new DynamicResolutionScaler();
  const scalerTrace: Array<Record<string, unknown>> = [];
  for (const value of Array.from({ length: 24 }, () => fullCost.p50)) {
    const decision = scaler.observe(value);
    scalerTrace.push({ frame: decision.frame, action: decision.action, reason: decision.reason, scale: Number(decision.scale.toFixed(4)) });
  }
  scaler.reset();
  const syntheticTrace: Array<Record<string, unknown>> = [];
  for (const value of Array.from({ length: 40 }, () => 24)) {
    const decision = scaler.observe(value);
    syntheticTrace.push({ frame: decision.frame, scale: Number(decision.scale.toFixed(4)) });
  }
  const evidence = { schema: "t07-temporal-sequences-gpu-evidence-v1", createdAt: new Date().toISOString(),
    lane: "t07-temporal-sequences-real-gpu",
    method: "生产 TEMPORAL_AA_WGSL(baseline)+ 生产 WGSL 注入 ghost-guard 决策层(与 temporalReprojection 同式,fail-fast 锚点)+ pbrShader.geometryOutput 同式 motion 内核;headless Chrome 真机 GPU",
    options: OPTIONS, sequences: cases, quality67: qualityCases,
    cost67: { report: internalResolutionReport(0.67, 1024, 576, { ssim: qualityCases[0]!.ssim as number,
      edgeRetention: qualityCases[0]!.edgeRetention as number,
      gpuCostRatio: Number(costRatio.toFixed(4)),
      note: "dual measured data: SSIM/edge from the 96->64 quality run, cost ratio from the 1024x576 run" }),
      fullMs: fullCost, internalMs: internalCost, measuredCostRatio: Number(costRatio.toFixed(4)),
      resolveOnlyRatio: Number(resolveOnlyRatio.toFixed(4)),
      resolveFullPerFrameMs: percentiles(gpuCost.resolveFullPerFrameMs), resolveInternalPerFrameMs: percentiles(gpuCost.resolveInternalPerFrameMs),
      note: "管线档 = motion + resolve(67% 档加一次全分辨率上采样);resolve 档 = 纯 TAA resolve 内核在两个内部尺寸下的对比" },
    scalerTrace: { measured: scalerTrace, syntheticOverload: syntheticTrace },
    verdict: { allPass: cases.every(item => (item as { pass: boolean }).pass),
      note: "残影口径 = measureGhostSequence(输出 vs 当前帧理想,归一化源对比度),切帧后 3 帧内 <0.05 达标;基线 TAA 与 guard 差异即决策层贡献;MV 容差含 rg16float 量化半 ulp" } };
  await writeFile(`${outputDir}evidence.json`, JSON.stringify(evidence, null, 2));
  await writeFile(fileURLToPath(new URL("../../../docs/reports/deep-core/assets/t07-temporal-sequences-gpu-2026-09-28.json", import.meta.url)),
    JSON.stringify(evidence, null, 2));
  if (!evidence.verdict.allPass) process.exitCode = 1;
  console.log(`verdict allPass=${evidence.verdict.allPass}`);
} finally { await browser.close(); server.close(); }
