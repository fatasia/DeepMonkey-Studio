import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import type { CascadedShadowQualityTier } from "../src/shadows/shadowQuality.js";
import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { isPbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import type { FrameMetrics, RenderView } from "../src/webgpu/pbrRendererTypes.js";
import {
  PROBE_WIDTH, PROBE_HEIGHT, VIEW, buildDeviceUpdate, buildProbeScene,
  downsampleLuma2x, edgeAliasingEnergy, fenceRegionFor, frameDistance, holeCheck, snapshotToLuma,
  type LumaField, type ShadowEdgeStats,
} from "./virtualShadowProbeScene.js";

// B1 Brief-VSM probe 腿会话与结果合同职责(sourceSizeGate 拆分:自 virtualShadowGpuProbe.ts
// 按职责分文件,代码逐行同源,仅改可见性;语义零变化)。
// 职责:腿常量(SETTLE_FRAMES/TIMING_FRAMES/FEATURES)、模块级腿状态(active/activeView
// 单例,setActiveView 切机位)、beginLeg/settleLeg/timeLeg/latestLuma/captureStill/
// dynamicLatencyLeg/finishLeg 生命周期与 ProbeLegResult/ShadowBandField 合同。
// 诊断模块经 getActiveLeg() 读取同一份状态(不复制)。

const SETTLE_FRAMES = 30;
const TIMING_FRAMES = 120;

// contactShadows 显式关:C10 近场遮蔽属另一条被动链,隔离主阴影域口径;
// temporalAa 关:动态延迟测逐帧像素差,时域历史会拖尾帧序。
const FEATURES = { environment: true, fog: false, groundPlane: true, groundGrid: false,
  contactShadows: false, ambientOcclusion: false, temporalAa: false, spatialAa: false,
  occlusionCulling: false, bloom: false, vignette: true } as const;

export interface ShadowBandField {
  readonly width: number; readonly height: number;
  readonly luma: Float32Array;
}

export interface ProbeLegResult {
  readonly mode: "cascaded" | "virtual" | "reference";
  readonly timing: { readonly p50Ms: number; readonly p95Ms: number; readonly samples: number };
  readonly image: { readonly edge: ShadowEdgeStats; readonly holes: { nonFinite: number; blackSpeckles: number;
    samples: number }; readonly lumaP05: number; readonly lumaP95: number;
    readonly canvasPng?: string; readonly cropPng?: string; readonly shadowBand?: ShadowBandField };
  /** 画布 PNG dataURL(证据存档;finishLeg 移除 canvas 前采集)。 */
  readonly canvasPng?: string;
  readonly shadowBand?: ShadowBandField;
  /** 门①口径裁决:同腿连续多组锯齿采样(5 组)与 4×SSAA 参考腿测区场。 */
  readonly edgeSamples?: readonly ShadowEdgeStats[];
  readonly ssaaBand?: ShadowBandField;
  readonly pages: readonly { readonly frame: number; readonly materialized: number; readonly resident: number;
    readonly dynamicInvalidated: number }[];
  readonly dynamic: { readonly translateLatencyFrames: number; readonly rotateLatencyFrames: number };
  readonly error?: string;
}

interface ActiveLeg {
  readonly mode: "cascaded" | "virtual" | "reference";
  readonly withCapture: boolean;
  /** 门①固定档钉法腿:渲染视分辨率倍率(2 = 4×SSAA 证据腿;1 = 现行口径)。 */
  readonly supersample: 1 | 2;
  readonly canvas: HTMLCanvasElement;
  readonly renderer: PbrRenderer;
  pages: { frame: number; materialized: number; resident: number; dynamicInvalidated: number }[];
}

let active: ActiveLeg | undefined;
/** 当前腿渲染视(近景 = VIEW 保持 B1 口径;远景 = VIEW_FAR 供门①)。 */
let activeView: RenderView = VIEW;

export function setActiveView(view: RenderView): void {
  if (active) throw new Error("Cannot switch view while a leg is active.");
  activeView = view;
}

/** 腿实际渲染视:SSAA 腿取当前视同构 2× 分辨率副本(相机合同不变,仅像素密度翻倍)。 */
function legRenderView(): RenderView {
  const leg = active;
  if (leg === undefined || leg.supersample === 1) return activeView;
  return { ...activeView, width: activeView.width * 2, height: activeView.height * 2 };
}

/** 门①固定档钉法腿选项(探针参数化,不硬编码档位;省略 = 现行默认口径):
 * - shadows:级联/参考腿的阴影图配置;requestedTier 钉固定档
 *   (selectProfile 走 resolveCascadedShadowQuality,与 exactProfile 互斥),VSM 腿忽略
 *   (页级驻留无档位,传入会被丢弃并在此显式拒绝,防口径漂移);
 * - supersample:2 时画布与渲染视按 2× 分辨率(4×SSAA 参考),下采样还原后量同一测区。 */
export interface BeginLegOptions {
  readonly shadows?: { readonly requestedTier?: CascadedShadowQualityTier;
    readonly exactProfile?: Readonly<{ cascadeCount: number; shadowMapSize: number }> };
  readonly supersample?: 1 | 2;
}

/** 诊断模块读取当前腿(与生命周期共享同一份模块级状态,不复制)。 */
export function getActiveLeg(): ActiveLeg | undefined {
  return active;
}

/** 逐帧 telemetry 页遥测采样(FrameMetrics.virtualShadow / virtualShadowPages)。 */
function samplePages(metrics: FrameMetrics | undefined, frame: number): void {
  if (!active) return;
  active.pages.push({ frame, materialized: metrics?.virtualShadow?.materializedPages ?? 0,
    resident: metrics?.virtualShadowPages?.residentPages ?? 0,
    dynamicInvalidated: metrics?.virtualShadow?.dynamicInvalidated ?? 0 });
}

export async function beginLeg(mode: "cascaded" | "virtual" | "reference", withCapture: boolean,
  options: BeginLegOptions = {}): Promise<void> {
  if (active) throw new Error("Previous probe leg was not ended.");
  const supersample = options.supersample ?? 1;
  if (mode === "virtual" && options.shadows !== undefined) {
    throw new Error("virtual leg takes no shadows option (page-resident VSM has no map-size tier); "
      + "pass shadows only on cascaded/reference legs to keep the comparison contract explicit.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = PROBE_WIDTH * supersample; canvas.height = PROBE_HEIGHT * supersample;
  canvas.style.width = `${PROBE_WIDTH * supersample}px`; canvas.style.height = `${PROBE_HEIGHT * supersample}px`;
  document.body.appendChild(canvas);
  const packet = buildProbeScene();
  const legShadows = mode === "reference"
    ? { exactProfile: options.shadows?.exactProfile ?? { cascadeCount: 1, shadowMapSize: 8192 } }
    : options.shadows;
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    ...(mode === "virtual" ? { shadowMode: "virtual" as const } : {}),
    ...(legShadows ? { shadows: legShadows } : {}),
    // AA-M1 并行任务在途(瞬时 MSAA 附件 store 语义在校),本探针显式 1x 隔离:
    // 锯齿能量测原生分辨率边缘,与 MSAA 正交,不碰 MSAA 域文件。
    msaaSampleCount: 1,
    // 诊断采样(gpu-frame timestamp 计时)需要 adaptiveQuality.enabled(msaaPerfProbe
    // 同配方);不开热点收集,短帧窗内自适应降档不触发。F1 逐 pass 计时同时开启:
    // PbrFramePassTimings 给出逐 pass 毫秒与 unavailable 原因(诊断面,不伪零)。
    // 固定档钉法:requestedTier 腿的 exactProfile 为空 → adaptiveShadowSize 恒 undefined
    // 且 stageAdaptiveShadow 仅在 exactProfile.cascadeCount===1 时生效 —— 档位由
    // requestedTier 唯一钉死,自适应压力不可达(pbrRenderer.refreshAdaptiveShadowRequest)。
    adaptiveQuality: { enabled: true, collectHotspots: false },
    gpuPassTiming: true,
    features: FEATURES,
    ...(withCapture ? { frameCapture: { session: new FrameCaptureSession(),
      readbacks: { requests: [{ resourceId: "present-color" }] } } } : {}),
  });
  renderer.setPacket(packet);
  renderer.setDiagnosticsSampling(true);
  if (!renderer.gpuTimer.supported) {
    throw new Error(`timestamp-query unavailable on this device (gpuTimer.supported=false); `
      + "gpu-frame 验收②需要 timestamp 查询,拒绝出伪零计时。");
  }
  active = { mode, withCapture, supersample, canvas, renderer, pages: [] };
}

export async function settleLeg(frames = SETTLE_FRAMES): Promise<readonly number[]> {
  if (!active) throw new Error("beginLeg was not called.");
  const gpuTimes: number[] = [];
  for (let index = 0; index < frames; index++) {
    const metrics = active.renderer.render(legRenderView());
    samplePages(metrics, index);
    if (index >= 8) {
      const gpu = active.renderer.performanceTelemetry.snapshot().stages["gpu-frame"];
      if (gpu) gpuTimes.push(gpu.p50Ms);
    }
  }
  await active.renderer.frameReadbackResults;
  return gpuTimes;
}

/** 计时段:无读回连续渲染,轮询 gpu-frame 阶段数据(诊断 timestamp 读回滞后,
 *  样本不足时继续渲染补采);返回 gpu-frame p50/p95。 */
export async function timeLeg(frames = TIMING_FRAMES): Promise<ProbeLegResult["timing"]> {
  if (!active) throw new Error("beginLeg was not called.");
  let gpu: { p50Ms: number; p95Ms: number; samples: number } | undefined;
  let passTimings: FrameMetrics["gpuPassTimings"] | undefined;
  for (let index = 0; index < frames; index++) {
    const metrics = active.renderer.render(legRenderView());
    if (metrics?.gpuPassTimings && passTimings === undefined) passTimings = metrics.gpuPassTimings;
    // 逐帧背压(msaaPerfProbe 同法):等本帧 GPU 工作完成,时间戳读回微任务才有机会落袋。
    await active.renderer.session.device.queue.onSubmittedWorkDone().catch(() => { /* lost device */ });
    if (index >= 16 && index % 8 === 7) {
      const stage = active.renderer.performanceTelemetry.snapshot().stages["gpu-frame"];
      if (stage && stage.samples >= 8) { gpu = stage; break; }
    }
  }
  // GPU 时间戳读回滞后 1-2 帧:收尾后再给微任务 300ms 落袋窗口。
  if (!gpu) {
    for (let settle = 0; settle < 12 && !gpu; settle++) {
      await new Promise(resolve => setTimeout(resolve, 25));
      const stage = active.renderer.performanceTelemetry.snapshot().stages["gpu-frame"];
      if (stage && stage.samples >= 1) gpu = stage;
    }
  }
  if (!gpu && passTimings && passTimings.availability === "measured") {
    gpu = { p50Ms: passTimings.milliseconds ?? 0, p95Ms: passTimings.milliseconds ?? 0, samples: 1 };
  }
  if (!gpu && passTimings) {
    throw new Error(`gpu-frame + pass timing unavailable; passTimings=${JSON.stringify(passTimings).slice(0, 400)}; `
      + `timer failures=[${active.renderer.gpuTimer.diagnostics.join(" | ")}]`);
  }
  if (!gpu) {
    const stage = active.renderer.performanceTelemetry.snapshot().stages["gpu-frame"];
    if (stage) gpu = stage;
  }
  if (!gpu) {
    const stages = active.renderer.performanceTelemetry.snapshot().stages;
    const stageSummary = Object.entries(stages)
      .map(([key, value]) => `${key}:${value?.samples ?? 0}`).join(",") || "none";
    throw new Error(`gpu-frame timing unavailable; timer failures=[${active.renderer.gpuTimer.diagnostics.join(" | ")}]; `
      + `stages=[${stageSummary}]`);
  }
  return { p50Ms: gpu.p50Ms, p95Ms: gpu.p95Ms, samples: gpu.samples };
}

async function latestLuma(): Promise<LumaField> {
  if (!active) throw new Error("beginLeg was not called.");
  const results = await active.renderer.frameReadbackResults;
  const snapshot = (results ?? []).find(isPbrFrameReadbackSnapshot);
  if (!snapshot) throw new Error("present-color readback unavailable.");
  return snapshotToLuma(snapshot);
}

/** 静态捕获:栅栏条纹测区锯齿能量 + 零洞检查 + 亮度分位 + 画布 PNG 存档。 */
export async function captureStill(): Promise<ProbeLegResult["image"] & { readonly canvasPng: string }> {
  if (!active) throw new Error("beginLeg was not called.");
  // 渲染 3 帧(首帧供 capture 管道就绪),读最后一帧;设备诊断随帧镜像。
  const deviceErrors: readonly { readonly kind: string; readonly message: string }[] =
    active.renderer.deviceDiagnostics;
  if (deviceErrors.length > 0) throw new Error(`device validation: ${deviceErrors.map(e => e.message).join(" | ")}`);
  for (let index = 0; index < 3; index++) { active.renderer.render(legRenderView()); samplePages(undefined, index); }
  const afterErrors = active.renderer.deviceDiagnostics;
  if (afterErrors.length > 0) throw new Error(`device validation: ${afterErrors.map(e => e.message).join(" | ")}`);
  const field = await latestLuma();
  // 测区 = 中央净空地面走廊(避开左右前景设备箱的暗面与远景球墙)。
  const fenceRegion = fenceRegionFor(field);
  const edge = edgeAliasingEnergy(field, fenceRegion);
  const holes = holeCheck(field, fenceRegion);
  const sorted = Float32Array.from(field.luma).sort();
  const percentile = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
  // 栅栏阴影近景裁剪(x 0.18..0.62,y 0.60..0.92 原生分辨率,2× 放大贴回画布右侧)
  const cropW = Math.floor((fenceRegion.x1 - fenceRegion.x0) * 0.44);
  const cropH = Math.floor(fenceRegion.y1 - fenceRegion.y0);
  const cropCanvas = new OffscreenCanvas(cropW, cropH);
  const cropContext = cropCanvas.getContext("2d")!;
  const full = new OffscreenCanvas(field.width, field.height);
  const fullContext = full.getContext("2d")!;
  const imageData = fullContext.createImageData(field.width, field.height);
  for (let y = 0; y < field.height; y++) for (let x = 0; x < field.width; x++) {
    const luma = Math.max(0, Math.min(1, field.luma[y * field.width + x]!));
    const gray = Math.round(luma * 255), offset = (y * field.width + x) * 4;
    imageData.data[offset] = gray; imageData.data[offset + 1] = gray; imageData.data[offset + 2] = gray;
    imageData.data[offset + 3] = 255;
  }
  fullContext.putImageData(imageData, 0, 0);
  cropContext.imageSmoothingEnabled = false;
  cropContext.drawImage(full, fenceRegion.x0, fenceRegion.y0, cropW, cropH, 0, 0, cropW, cropH);
  const cropBlob = await cropCanvas.convertToBlob({ type: "image/png" });
  const cropBytes = new Uint8Array(await cropBlob.arrayBuffer());
  let cropBinary = "";
  for (let index = 0; index < cropBytes.length; index++) cropBinary += String.fromCharCode(cropBytes[index]!);
  const band = { width: fenceRegion.x1 - fenceRegion.x0, height: fenceRegion.y1 - fenceRegion.y0,
    luma: new Float32Array((fenceRegion.x1 - fenceRegion.x0) * (fenceRegion.y1 - fenceRegion.y0)) };
  for (let y = fenceRegion.y0; y < fenceRegion.y1; y++) for (let x = fenceRegion.x0; x < fenceRegion.x1; x++) {
    band.luma[(y - fenceRegion.y0) * band.width + (x - fenceRegion.x0)] = field.luma[y * field.width + x]!;
  }
  return { edge, holes, lumaP05: percentile(0.05), lumaP95: percentile(0.95),
    canvasPng: active.canvas.toDataURL("image/png"),
    cropPng: `data:image/png;base64,${btoa(cropBinary)}`, shadowBand: band };
}

/**
 * 门①口径裁决 5 组采样:当前腿连续 count 次「渲染 3 帧 → 读回 → 同测区锯齿统计」。
 * 不产 PNG(证据 PNG 由调用方另采一次 captureStill 存档),JSON 不膨胀。
 * VSM 腿页物化在 settle 后收敛,组间差异反映帧间稳定性而非物化暂态。
 */
export async function captureEdgeSamples(count: number): Promise<ShadowEdgeStats[]> {
  if (!active) throw new Error("beginLeg was not called.");
  if (!Number.isInteger(count) || count < 1) throw new RangeError("captureEdgeSamples count must be a positive integer.");
  const samples: ShadowEdgeStats[] = [];
  for (let index = 0; index < count; index++) {
    for (let frame = 0; frame < 3; frame++) {
      active.renderer.render(legRenderView());
      samplePages(undefined, frame);
    }
    const field = await latestLuma();
    samples.push(edgeAliasingEnergy(field, fenceRegionFor(field)));
  }
  return samples;
}

/**
 * 门①备选"分辨率敏感度量":本腿为 supersample=2 腿时,渲染 → 2× 读回 → 2×2 box
 * 下采样还原 1× → 同测区锯齿统计(4×SSAA 参考)。与同腿位 1× 腿的 5 组采样拼成
 * "1× 边缘能量 / 4×SSAA 参考边缘能量"比值 —— 锯齿来源判别:比值≈1 = 锯齿来自
 * 阴影图 texel(图受限);比值≫1 = 锯齿来自屏幕像素网格(分辨率敏感,VSM 可降)。
 */
/**
 * 门①备选"分辨率敏感度量":本腿为 supersample=2 腿时,渲染 → 2× 读回 → 2×2 box
 * 下采样还原 1×(4×SSAA 参考)。返回下采样后测区 luma 场与整帧 PNG;调用方用
 * meanAbsDiff(同腿位 1× 腿的 still.shadowBand,本 band)得"1× 渲染偏离 4×SSAA
 * 参考的亮度差"= 锯齿成分能量。不在此重算掩码角密度:高对比边界下 2×2 均值的
 * 0.5 过渡值被 0.55 阈值整体归入暗侧,阶梯形状保持,角密度对 SSAA 不敏感(实测)。
 */
export async function captureStillSsaa(): Promise<{ band: ShadowBandField; canvasPng: string }> {
  if (!active) throw new Error("beginLeg was not called.");
  if (active.supersample !== 2) throw new Error("captureStillSsaa requires a supersample=2 leg.");
  for (let index = 0; index < 3; index++) {
    active.renderer.render(legRenderView());
    samplePages(undefined, index);
  }
  const field = await latestLuma();
  const downsampled = downsampleLuma2x(field);
  const region = fenceRegionFor(downsampled);
  const band: ShadowBandField = { width: region.x1 - region.x0, height: region.y1 - region.y0,
    luma: new Float32Array((region.x1 - region.x0) * (region.y1 - region.y0)) };
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      band.luma[(y - region.y0) * band.width + (x - region.x0)] = downsampled.luma[y * downsampled.width + x]!;
    }
  }
  return { band, canvasPng: active.canvas.toDataURL("image/png") };
}

/** 动态腿:updateInstances → 逐帧差分,返回与收敛帧差降到初始差 50% 的帧序(0 = 同帧)。 */
export async function dynamicLatencyLeg(mode: "translate" | "rotate",
  maxFrames = 6): Promise<number> {
  if (!active || !active.withCapture) throw new Error("dynamic latency requires a capture leg.");
  const renderer = active.renderer;
  const before: LumaField[] = [];
  for (let index = 0; index < 3; index++) {
    try { renderer.render(legRenderView()); }
    catch (error) {
      throw new Error(`baseline render failed: ${String(error)}; device=[${renderer.deviceDiagnostics.map(e => e.message).join(" | ")}]`);
    }
    samplePages(undefined, index);
    before.push(await latestLuma());
  }
  const baseline = before[2]!;
  renderer.updateInstances({ materials: [
    { id: "device", baseColor: [0.85, 0.45, 0.2], metallic: 0.4, roughness: 0.45 },
  ], instances: buildDeviceUpdate(mode) });
  const distances: number[] = [];
  for (let index = 0; index < maxFrames; index++) {
    let metrics: FrameMetrics | undefined;
    try { metrics = renderer.render(legRenderView()); }
    catch (error) {
      throw new Error(`render failed after ${mode} update: ${String(error)}; device=[${renderer.deviceDiagnostics.map(e => e.message).join(" | ")}]`);
    }
    samplePages(metrics, index);
    const field = await latestLuma();
    distances.push(frameDistance(baseline, field));
  }
  const finalDistance = distances[distances.length - 1]!;
  for (let index = 0; index < distances.length; index++) {
    if (distances[index]! <= Math.max(finalDistance, distances[0]! * 0.5)) return index;
  }
  return maxFrames;
}

/** 组装腿结果并释放渲染器(withCapture 腿完成 capture/dynamic 后调用)。 */
export async function finishLeg(timing: ProbeLegResult["timing"], image?: ProbeLegResult["image"],
  dynamic?: ProbeLegResult["dynamic"], edgeSamples?: readonly ShadowEdgeStats[]): Promise<ProbeLegResult> {
  if (!active) throw new Error("beginLeg was not called.");
  const leg: ProbeLegResult = { mode: active.mode, timing,
    image: image ?? { edge: { boundaryPixels: 0, cornerPixels: 0, cornerRatio: 0, boundaryLength: 0,
      shadowPixels: 0, brightMean: 0, shadowMean: 0 }, holes: { nonFinite: 0, blackSpeckles: 0, samples: 0 },
      lumaP05: 0, lumaP95: 0 },
    ...(edgeSamples ? { edgeSamples } : {}),
    pages: active.pages,
    dynamic: dynamic ?? { translateLatencyFrames: -1, rotateLatencyFrames: -1 } };
  active.renderer.dispose();
  active.canvas.remove();
  active = undefined;
  return leg;
}
