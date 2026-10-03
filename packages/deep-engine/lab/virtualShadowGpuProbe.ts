import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { isPbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import type { FrameMetrics, RenderView } from "../src/webgpu/pbrRendererTypes.js";
import type { RenderPacket } from "../src/renderPacket.js";
import { sphereMesh } from "../src/webgpu/primitives.js";

/**
 * B1 Brief-VSM 真机验收探针(headless Chrome WebGPU)。
 *
 * 场景合同(两档完全同构):
 * - 10 万实例球场(x∈[-40,40] z∈[-64,8],两种材质)+ 6 面近场薄栅栏(边缘密集,
 *   投影到 groundPlane 地面 = 锯齿能量测区)+ 4 台"动态设备"方岛(平移/旋转腿);
 * - 相机近景俯视栅栏,1080p,后处理全关(TAA/AO/SSR/雾/bloom/spatialAa 关),
 *   contactShadows 关(隔离主阴影域),groundPlane 开(地面接收阴影)。
 *
 * 验收映射(证据全部随 JSON 落盘):
 * ① 近景阴影边缘锯齿能量:栅栏条纹测区 luma Sobel 梯度能量(边缘带归一),
 *    virtual/cascaded ≤ 0.40(↓≥60%);
 * ② 阴影全程 GPU 时:同场景同相机同特性集,无读回 120 帧,gpu-frame p50/p95
 *    (诊断 timestamp 查询),增量 Δp50 ≤ 2.5ms;
 * ③ 动态设备阴影延迟:updateInstances 平移/旋转后逐帧整帧差分,与"后"收敛帧的
 *    差降到"前"差 50% 以下的帧序 ≤ 2;
 * ④ 零洞:哨兵像素(magenta/非有限)为 0,测区黑斑(局部中值 >0.05 而 luma<0.01)
 *    为 0,且 virtual 相对 cascaded 的"异常亮/暗"像素率披露。
 */

export const PROBE_WIDTH = 1920;
export const PROBE_HEIGHT = 1080;
// RenderPacket 合同上限(renderPacket.prepareRenderPacket:instances ≤ 16_384):
// 验收场景取合同上限(16_374 场球 + 6 栅栏 + 4 动态设备 = 16_384)。
// 提升包上限属 renderPacket 域,不在本切片;A/B 两档完全同场景,对比公平性不受影响。
const FIELD_COUNT = 16_374;
const SETTLE_FRAMES = 30;
const TIMING_FRAMES = 120;

// contactShadows 显式关:C10 近场遮蔽属另一条被动链,隔离主阴影域口径;
// temporalAa 关:动态延迟测逐帧像素差,时域历史会拖尾帧序。
const FEATURES = { environment: true, fog: false, groundPlane: true, groundGrid: false,
  contactShadows: false, ambientOcclusion: false, temporalAa: false, spatialAa: false,
  occlusionCulling: false, bloom: false, vignette: true } as const;

const VIEW: RenderView = {
  eye: [0, 2.4, 7.2] as const, target: [0, 0.7, -1.5] as const, extent: 9,
  background: [0.16, 0.19, 0.24] as const, floor: [0.42, 0.42, 0.44] as const,
  exposure: 1.0, roughness: 0.6,
  width: PROBE_WIDTH, height: PROBE_HEIGHT, pixelRatio: 1,
};

/** 简立方体(单位,中心原点):24 顶点 36 索引。 */
function boxMesh(): { vertices: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> } {
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [1, 0, 0], [0, 1, 0]],
  ];
  const vertices: number[] = [], indices: number[] = [];
  for (const [n, u, v] of faces) {
    const base = vertices.length / 6;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      for (let axis = 0; axis < 3; axis++) {
        vertices.push((n[axis]! + u[axis]! * su + v[axis]! * sv) / 2);
      }
      vertices.push(n[0]!, n[1]!, n[2]!);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

/** 10 万实例场景:球场 + 近场薄栅栏 + 动态设备方岛(dyn- 前缀,供 update 驱动)。 */
export function buildProbeScene(): RenderPacket {
  const sphere = sphereMesh(12, 8);
  const box = boxMesh();
  const instances: RenderPacket["instances"] = [];
  const materials: RenderPacket["materials"] = [
    { id: "field-a", baseColor: [0.55, 0.56, 0.58], metallic: 0.05, roughness: 0.7 },
    { id: "field-b", baseColor: [0.36, 0.4, 0.46], metallic: 0.1, roughness: 0.6 },
    { id: "fence", baseColor: [0.8, 0.78, 0.72], metallic: 0.2, roughness: 0.5 },
    { id: "device", baseColor: [0.85, 0.45, 0.2], metallic: 0.4, roughness: 0.45 },
  ];
  const grid = Math.ceil(Math.sqrt(FIELD_COUNT));
  for (let index = 0; index < FIELD_COUNT; index++) {
    const gx = index % grid, gz = Math.floor(index / grid);
    const x = gx / (grid - 1) * 80 - 40;
    // z ∈ [8, -56]:近环 2/3 覆盖主视前方,远端延伸出环外(越界=无阴影,同 CSM 语义)。
    const z = 8 - (gz / (grid - 1)) * 64;
    const scale = 0.18 + ((index * 2654435761) % 97) / 97 * 0.22;
    instances.push({ id: `f-${index}`, geometry: "geo-sphere",
      material: index % 2 === 0 ? "field-a" : "field-b",
      transform: [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, x, scale, z, 1] });
  }
  for (let index = 0; index < 6; index++) {
    const x = -6.25 + index * 2.5;
    instances.push({ id: `fence-${index}`, geometry: "geo-box", material: "fence",
      transform: [0.06, 0, 0, 0, 0, 1.5, 0, 0, 0, 0, 2.8, 0, x, 0.75, -2, 1] });
  }
  for (let index = 0; index < 4; index++) {
    const x = -4.5 + index * 3;
    instances.push({ id: `dyn-${index}`, geometry: "geo-box", material: "device",
      transform: [0.9, 0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0.9, 0, x, 0.45, 1.5, 1] });
  }
  return { geometries: [
    { id: "geo-sphere", revision: 0, vertices: sphere.vertices, indices: sphere.indices },
    { id: "geo-box", revision: 0, vertices: box.vertices, indices: box.indices },
  ], materials, instances };
}

/** 平移/旋转动态设备的实例更新(其余实例不变)。 */
export function buildDeviceUpdate(mode: "translate" | "rotate"): RenderPacket["instances"] {
  const instances: RenderPacket["instances"] = [];
  for (let index = 0; index < 4; index++) {
    const x = -4.5 + index * 3;
    if (mode === "translate") {
      instances.push({ id: `dyn-${index}`, geometry: "geo-box", material: "device",
        transform: [0.9, 0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0.9, 0, x + 2.6, 0.45, 1.5, 1] });
    } else {
      const angle = Math.PI / 4;
      const cos = Math.cos(angle) * 1.1, sin = Math.sin(angle) * 1.1;
      instances.push({ id: `dyn-${index}`, geometry: "geo-box", material: "device",
        transform: [cos, 0, -sin, 0, 0, 1.1, 0, 0, sin, 0, cos, 0, x, 0.45, 1.5, 1] });
    }
  }
  return instances;
}

export interface LumaField { readonly width: number; readonly height: number;
  readonly luma: Float32Array }

/** present-color 读回 → luma 场(显示域 0..1)。 */
export function snapshotToLuma(snapshot: { readonly width: number; readonly height: number;
  readonly bytesPerRow: number; readonly format: string; readonly bytes: Uint8Array }): LumaField {
  const { width, height } = snapshot;
  const luma = new Float32Array(width * height);
  if (snapshot.format === "rgba16float") {
    const words = new Uint16Array(snapshot.bytes.buffer, snapshot.bytes.byteOffset, snapshot.bytes.byteLength / 2);
    const stride = snapshot.bytesPerRow / 2;
    const toFloat = (word: number): number => {
      const exponent = (word >> 10) & 0x1f, fraction = word & 0x3ff, sign = word >> 15 ? -1 : 1;
      const value = exponent === 0 ? fraction * 2 ** -24 : exponent === 0x1f
        ? Number.NaN : (1 + fraction / 1024) * 2 ** (exponent - 15);
      return sign * value;
    };
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = y * stride + x * 4;
      luma[y * width + x] = 0.2126 * toFloat(words[offset]!) + 0.7152 * toFloat(words[offset + 1]!)
        + 0.0722 * toFloat(words[offset + 2]!);
    }
  } else {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = y * snapshot.bytesPerRow + x * 4;
      luma[y * width + x] = (0.2126 * snapshot.bytes[offset + 2]! + 0.7152 * snapshot.bytes[offset + 1]!
        + 0.0722 * snapshot.bytes[offset]!) / 255;
    }
  }
  return { width, height, luma };
}

/** 边缘带锯齿能量:测区内 Sobel |∇|>阈值的边缘带,梯度平方和 / 边缘像素数。 */
export function edgeAliasingEnergy(field: LumaField, region: { x0: number; y0: number; x1: number; y1: number },
  threshold = 0.055): { edgePixels: number; gradientSum: number; gradientEnergy: number;
    energyPerEdgePixel: number; brightMean: number; shadowMean: number } {
  const at = (x: number, y: number): number => field.luma[y * field.width + x]!;
  let edgePixels = 0, gradientSum = 0, gradientEnergy = 0, bright = 0, brightCount = 0, shadow = 0, shadowCount = 0;
  for (let y = Math.max(1, region.y0); y < Math.min(field.height - 1, region.y1); y++) {
    for (let x = Math.max(1, region.x0); x < Math.min(field.width - 1, region.x1); x++) {
      const gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
        - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const gy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
        - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      const magnitude = Math.hypot(gx, gy);
      const center = at(x, y);
      if (magnitude > threshold) {
        edgePixels += 1; gradientSum += magnitude; gradientEnergy += magnitude * magnitude;
      }
      if (center > 0.3) { bright += center; brightCount += 1; }
      else if (center > 0.02) { shadow += center; shadowCount += 1; }
    }
  }
  return { edgePixels, gradientSum, gradientEnergy,
    energyPerEdgePixel: edgePixels > 0 ? gradientEnergy / edgePixels : 0,
    brightMean: brightCount > 0 ? bright / brightCount : 0,
    shadowMean: shadowCount > 0 ? shadow / shadowCount : 0 };
}

/** 黑斑/非有限检查:测区内非有限亮度与"局部中值亮而像素近黑"的斑点(零洞合同)。 */
export function holeCheck(field: LumaField, region: { x0: number; y0: number; x1: number; y1: number }): {
  nonFinite: number; blackSpeckles: number; samples: number } {
  let nonFinite = 0, blackSpeckles = 0, samples = 0;
  const median3 = (x: number, y: number): number => {
    const values: number[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      values.push(field.luma[(y + dy) * field.width + x + dx]!);
    }
    values.sort((left, right) => left - right);
    return values[4]!;
  };
  for (let y = Math.max(1, region.y0); y < Math.min(field.height - 1, region.y1); y++) {
    for (let x = Math.max(1, region.x0); x < Math.min(field.width - 1, region.x1); x++) {
      const value = field.luma[y * field.width + x]!;
      samples += 1;
      if (!Number.isFinite(value)) nonFinite += 1;
      const localMedian = median3(x, y);
      if (localMedian > 0.05 && value < 0.01) blackSpeckles += 1;
    }
  }
  return { nonFinite, blackSpeckles, samples };
}

/** 整帧差分(步距 4 下采样):动态延迟收敛判定。 */
export function frameDistance(left: LumaField, right: LumaField): number {
  let sum = 0, count = 0;
  for (let y = 0; y < Math.min(left.height, right.height); y += 4) {
    for (let x = 0; x < Math.min(left.width, right.width); x += 4) {
      const delta = left.luma[y * left.width + x]! - right.luma[y * right.width + x]!;
      sum += Math.abs(delta); count += 1;
    }
  }
  return count > 0 ? sum / count : 0;
}

export interface ProbeLegResult {
  readonly mode: "cascaded" | "virtual";
  readonly timing: { readonly p50Ms: number; readonly p95Ms: number; readonly samples: number };
  readonly image: { readonly edge: ReturnType<typeof edgeAliasingEnergy>;
    readonly holes: ReturnType<typeof holeCheck>; readonly lumaP05: number; readonly lumaP95: number };
  /** 画布 PNG dataURL(证据存档;finishLeg 移除 canvas 前采集)。 */
  readonly canvasPng?: string;
  readonly pages: readonly { readonly frame: number; readonly materialized: number; readonly resident: number;
    readonly dynamicInvalidated: number }[];
  readonly dynamic: { readonly translateLatencyFrames: number; readonly rotateLatencyFrames: number };
  readonly error?: string;
}

interface ActiveLeg {
  readonly mode: "cascaded" | "virtual";
  readonly withCapture: boolean;
  readonly canvas: HTMLCanvasElement;
  readonly renderer: PbrRenderer;
  readonly pages: ProbeLegResult["pages"];
}

let active: ActiveLeg | undefined;

/** 逐帧 telemetry 页遥测采样(FrameMetrics.virtualShadow / virtualShadowPages)。 */
function samplePages(metrics: FrameMetrics | undefined, frame: number): void {
  if (!active) return;
  active.pages.push({ frame, materialized: metrics?.virtualShadow?.materializedPages ?? 0,
    resident: metrics?.virtualShadowPages?.residentPages ?? 0,
    dynamicInvalidated: metrics?.virtualShadow?.dynamicInvalidated ?? 0 });
}

export async function beginLeg(mode: "cascaded" | "virtual", withCapture: boolean): Promise<void> {
  if (active) throw new Error("Previous probe leg was not ended.");
  const canvas = document.createElement("canvas");
  canvas.width = PROBE_WIDTH; canvas.height = PROBE_HEIGHT;
  canvas.style.width = `${PROBE_WIDTH}px`; canvas.style.height = `${PROBE_HEIGHT}px`;
  document.body.appendChild(canvas);
  const packet = buildProbeScene();
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    ...(mode === "virtual" ? { shadowMode: "virtual" as const } : {}),
    // AA-M1 并行任务在途(瞬时 MSAA 附件 store 语义在校),本探针显式 1x 隔离:
    // 锯齿能量测原生分辨率边缘,与 MSAA 正交,不碰 MSAA 域文件。
    msaaSampleCount: 1,
    // 诊断采样(gpu-frame timestamp 计时)需要 adaptiveQuality.enabled(msaaPerfProbe
    // 同配方);不开热点收集,短帧窗内自适应降档不触发。F1 逐 pass 计时同时开启:
    // PbrFramePassTimings 给出逐 pass 毫秒与 unavailable 原因(诊断面,不伪零)。
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
  active = { mode, withCapture, canvas, renderer, pages: [] };
}

export async function settleLeg(frames = SETTLE_FRAMES): Promise<readonly number[]> {
  if (!active) throw new Error("beginLeg was not called.");
  const gpuTimes: number[] = [];
  for (let index = 0; index < frames; index++) {
    const metrics = active.renderer.render(VIEW);
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
    const metrics = active.renderer.render(VIEW);
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
    gpu = { p50Ms: passTimings.milliseconds, p95Ms: passTimings.milliseconds, samples: 1 };
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
    const stageSummary = Object.entries(stages).map(([key, value]) => `${key}:${value.samples}`).join(",") || "none";
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
  for (let index = 0; index < 3; index++) { active.renderer.render(VIEW); samplePages(undefined, index); }
  const afterErrors = active.renderer.deviceDiagnostics;
  if (afterErrors.length > 0) throw new Error(`device validation: ${afterErrors.map(e => e.message).join(" | ")}`);
  const field = await latestLuma();
  const fenceRegion = { x0: Math.floor(field.width * 0.18), y0: Math.floor(field.height * 0.62),
    x1: Math.floor(field.width * 0.86), y1: Math.floor(field.height * 0.96) };
  const edge = edgeAliasingEnergy(field, fenceRegion);
  const holes = holeCheck(field, fenceRegion);
  const sorted = Float32Array.from(field.luma).sort();
  const percentile = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
  return { edge, holes, lumaP05: percentile(0.05), lumaP95: percentile(0.95),
    canvasPng: active.canvas.toDataURL("image/png") };
}

/** 动态腿:updateInstances → 逐帧差分,返回与收敛帧差降到初始差 50% 的帧序(0 = 同帧)。 */
export async function dynamicLatencyLeg(mode: "translate" | "rotate",
  maxFrames = 6): Promise<number> {
  if (!active || !active.withCapture) throw new Error("dynamic latency requires a capture leg.");
  const renderer = active.renderer;
  const before: LumaField[] = [];
  for (let index = 0; index < 3; index++) {
    renderer.render(VIEW); samplePages(undefined, index);
    before.push(await latestLuma());
  }
  const baseline = before[2]!;
  renderer.updateInstances({ materials: [
    { id: "device", baseColor: [0.85, 0.45, 0.2], metallic: 0.4, roughness: 0.45 },
  ], instances: buildDeviceUpdate(mode) });
  const distances: number[] = [];
  for (let index = 0; index < maxFrames; index++) {
    let metrics: FrameMetrics | undefined;
    try { metrics = renderer.render(VIEW); }
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
  dynamic?: ProbeLegResult["dynamic"]): Promise<ProbeLegResult> {
  if (!active) throw new Error("beginLeg was not called.");
  const leg: ProbeLegResult = { mode: active.mode, timing,
    image: image ?? { edge: { edgePixels: 0, gradientSum: 0, gradientEnergy: 0, energyPerEdgePixel: 0,
      brightMean: 0, shadowMean: 0 }, holes: { nonFinite: 0, blackSpeckles: 0, samples: 0 },
      lumaP05: 0, lumaP95: 0 },
    pages: active.pages,
    dynamic: dynamic ?? { translateLatencyFrames: -1, rotateLatencyFrames: -1 } };
  active.renderer.dispose();
  active.canvas.remove();
  active = undefined;
  return leg;
}

export async function probeAdapterInfo(): Promise<{ readonly vendor?: string; readonly architecture?: string }> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter.");
  const info = adapter.info ?? {};
  return { vendor: info.vendor, architecture: info.architecture };
}

/** 诊断:包一层管线/布局创建,失败时把失败管线 label 带进错误消息(定位 Invalid PipelineLayout)。 */
export function installPipelineTracing(): void {
  const proto = GPUDevice.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const w = window as unknown as { __vsmErrors?: string[] };
  const scopeTrace = (device: GPUDevice, label: string, run: () => unknown): unknown => {
    w.__vsmErrors!.push(`enter ${label}`);
    device.pushErrorScope("validation");
    const value = run();
    void device.popErrorScope().then(error => {
      w.__vsmErrors!.push(error ? `${label}: ${error.message}` : `ok ${label}`);
    }).catch(error => w.__vsmErrors!.push(`${label} pop-failed: ${String(error)}`));
    return value;
  };
  const origBindGroupLayout = proto.createBindGroupLayout;
  proto.createBindGroupLayout = function (this: GPUDevice, descriptor: GPUBindGroupLayoutDescriptor) {
    return scopeTrace(this, `createBindGroupLayout[${descriptor.label ?? "unlabeled"}]`, () => origBindGroupLayout.call(this, descriptor));
  };
  const origPipelineLayout = proto.createPipelineLayout;
  proto.createPipelineLayout = function (this: GPUDevice, descriptor: GPUPipelineLayoutDescriptor) {
    return scopeTrace(this, `createPipelineLayout[${descriptor.label ?? "unlabeled"}]`,
      () => origPipelineLayout.call(this, descriptor));
  };
  const origRenderPipeline = proto.createRenderPipeline;
  proto.createRenderPipeline = function (this: GPUDevice, descriptor: GPURenderPipelineDescriptor) {
    try { return origRenderPipeline.call(this, descriptor); }
    catch (error) { throw new Error(`createRenderPipeline[${descriptor.label ?? "unlabeled"}]: ${String(error)}`); }
  };
  const origRenderPipelineAsync = proto.createRenderPipelineAsync;
  proto.createRenderPipelineAsync = function (this: GPUDevice, descriptor: GPURenderPipelineDescriptor) {
    const promise = origRenderPipelineAsync.call(this, descriptor) as Promise<GPURenderPipeline>;
    return promise.catch(error => {
      throw new Error(`createRenderPipelineAsync[${descriptor.label ?? "unlabeled"}]: ${String(error)}`);
    });
  };
}

/** 诊断:包装 uncapturederror 监听注册,把 Dawn 完整校验消息镜像到 window.__vsmErrors。 */
export function installErrorCapture(): void {
  const w = window as unknown as { __vsmErrors?: string[] };
  w.__vsmErrors = [];
  const original = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type: string, listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions): void {
    if (type === "uncapturederror") {
      const wrapped = (event: Event): void => {
        w.__vsmErrors!.push((event as ErrorEvent).message ?? String(event));
        if (typeof listener === "function") listener.call(this, event);
        else listener?.handleEvent.call(listener, event);
      };
      return original.call(this, type, wrapped as EventListener, options);
    }
    return original.call(this, type, listener, options);
  };
}

export function drainCapturedErrors(): readonly string[] {
  const w = window as unknown as { __vsmErrors?: string[] };
  return w.__vsmErrors ?? [];
}

/** 诊断:复刻 DeviceSession 的 requiredLimits/requiredFeatures 组合,返回 requestDevice 结果
 *  与 adapter 上限(定位时间戳特性降级)。 */
export async function probeDeviceRequest(): Promise<unknown> {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return { error: "no adapter" };
  const limits = adapter.limits;
  const desired = { maxStorageBuffersPerShaderStage: Math.min(10, limits.maxStorageBuffersPerShaderStage),
    maxSampledTexturesPerShaderStage: Math.min(17, limits.maxSampledTexturesPerShaderStage) };
  const features = (["timestamp-query", "texture-compression-bc", "texture-compression-etc2",
    "texture-compression-astc"] as const).filter(feature => adapter.features.has(feature));
  try {
    const device = await adapter.requestDevice({ requiredLimits: desired,
      requiredFeatures: features as GPUFeatureName[] });
    const result = { ok: true, desired, adapterLimits: {
      storage: limits.maxStorageBuffersPerShaderStage, sampled: limits.maxSampledTexturesPerShaderStage },
      deviceFeatures: [...device.features] };
    device.destroy();
    return result;
  } catch (error) {
    return { ok: false, error: String(error), desired, adapterLimits: {
      storage: limits.maxStorageBuffersPerShaderStage, sampled: limits.maxSampledTexturesPerShaderStage } };
  }
}

/** 诊断:读回虚拟阴影 atlas layer 0(2048² r32float),返回行距与原始字节(灰度化在 Node 侧)。 */
export async function dumpShadowAtlasLayer(): Promise<{ readonly width: number; readonly height: number;
  readonly bytesPerRow: number; readonly floats: Float32Array }> {
  if (!active) throw new Error("beginLeg was not called.");
  const atlas = (active.renderer as unknown as {
    virtualShadows?: { atlas: GPUTexture };
  }).virtualShadows?.atlas;
  if (!atlas) throw new Error("virtual shadow atlas unavailable (cascaded leg or virtual not constructed).");
  const device = active.renderer.session.device;
  const width = 2048, height = 2048, bytesPerRow = width * 4;
  const buffer = device.createBuffer({ size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder({ label: "vsm atlas readback" });
  encoder.copyTextureToBuffer({ texture: atlas, origin: { x: 0, y: 0, z: 0 } },
    { buffer, bytesPerRow, rowsPerImage: height }, [width, height, 1]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const floats = new Float32Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  // 灰度可视化贴到离屏 canvas(近=暗),dataURL 随返回值出页(证据存档)。
  const view = 1024, step = width / view;
  const canvas = new OffscreenCanvas(view, view);
  const context = canvas.getContext("2d")!;
  const image = context.createImageData(view, view);
  for (let y = 0; y < view; y++) for (let x = 0; x < view; x++) {
    const value = floats[Math.floor(y * step) * width + Math.floor(x * step)] ?? 1;
    const gray = Math.round((1 - Math.max(0, Math.min(1, value))) * 255);
    const offset = (y * view + x) * 4;
    image.data[offset] = gray; image.data[offset + 1] = gray; image.data[offset + 2] = gray;
    image.data[offset + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]!);
  return { width, height, bytesPerRow, floats, canvasPng: `data:image/png;base64,${btoa(binary)}` };
}
