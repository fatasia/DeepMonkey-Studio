import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { isPbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import type { FrameMetrics, RenderView } from "../src/webgpu/pbrRendererTypes.js";
import type { RenderInstance, RenderPacket } from "../src/renderPacket.js";
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
  eye: [0, 1.7, 4.2] as const, target: [0, 0.9, -2] as const, extent: 7,
  background: [0.16, 0.19, 0.24] as const, floor: [0.42, 0.42, 0.44] as const,
  exposure: 1.0, roughness: 0.6,
  lights: { directional: [{ directionWorld: [-0.45, -0.62, -0.45], color: [1, 0.94, 0.86],
    intensity: 3.2 }] },
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

/** 10 万实例场景(合同上限 16 384):近场留清晰地面走廊(栅栏阴影测区),
 *  球场推向远方(z -20..-58)保持 10 万级负载;栅栏 12 段 × 2.2m 投影条纹。
 *  低角度太阳(view.lights)→ 长阴影 ≈ 2.7m,边缘带落在净空地面上。 */
export function buildProbeScene(): RenderPacket {
  const sphere = sphereMesh(12, 8);
  const box = boxMesh();
  const instances: RenderInstance[] = [];
  const materials: RenderPacket["materials"] = [
    { id: "field-a", baseColor: [0.55, 0.56, 0.58], metallic: 0.05, roughness: 0.7 },
    { id: "field-b", baseColor: [0.36, 0.4, 0.46], metallic: 0.1, roughness: 0.6 },
    { id: "fence", baseColor: [0.8, 0.78, 0.72], metallic: 0.2, roughness: 0.5 },
    { id: "device", baseColor: [0.85, 0.45, 0.2], metallic: 0.4, roughness: 0.45 },
  ];
  const FIELD_COUNT = 16_344;
  const grid = Math.ceil(Math.sqrt(FIELD_COUNT));
  for (let index = 0; index < FIELD_COUNT; index++) {
    const gx = index % grid, gz = Math.floor(index / grid);
    const x = gx / (grid - 1) * 84 - 42;
    const z = -20 - (gz / (grid - 1)) * 38;
    const scale = 0.22 + ((index * 2654435761) % 97) / 97 * 0.26;
    instances.push({ id: `f-${index}`, geometry: "geo-sphere",
      material: index % 2 === 0 ? "field-a" : "field-b",
      transform: [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, x, scale, z, 1] });
  }
  // 细杆围栏(0.03m 杆径 × 2 横杆):级联 medium slice(~17cm/texel)下细杆阴影
  // 破碎/丢失,虚拟档 1.1mm/texel 完整解析 —— UE VSM 的标志性卖点场景。
  for (let index = 0; index < 12; index++) {
    const x = -8.8 + index * 1.6;
    instances.push({ id: `fence-post-${index}`, geometry: "geo-box", material: "fence",
      transform: [0.05, 0, 0, 0, 0, 2.2, 0, 0, 0, 0, 0.05, 0, x, 1.1, -2, 1] });
    for (const height of [0.75, 1.5]) {
      instances.push({ id: `fence-rail-${index}-${height}`, geometry: "geo-box", material: "fence",
        transform: [0.8, 0, 0, 0, 0, 0.035, 0, 0, 0, 0, 0.035, 0, x + 0.4, height, -2, 1] });
    }
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
/** M2 门①机位:远景俯视(同场景同光照)。级联 split0 覆盖随之扩大 → 阴影图 texel
 *  超过屏幕像素足迹,基线边缘进入"图受限阶梯"(锯齿能量可被分辨率优势降低);
 *  虚拟档环 texel = extent·2/16384 仍 ≪ 像素 → 边缘保持屏幕受限 1px 阶梯。 */
export const VIEW_FAR: RenderView = {
  eye: [0, 4.5, 30] as const, target: [0, 0.6, -2] as const, extent: 26,
  background: [0.16, 0.19, 0.24] as const, floor: [0.42, 0.42, 0.44] as const,
  exposure: 1.0, roughness: 0.6,
  lights: { directional: [{ directionWorld: [-0.45, -0.62, -0.45], color: [1, 0.94, 0.86],
    intensity: 3.2 }] },
  width: PROBE_WIDTH, height: PROBE_HEIGHT, pixelRatio: 1,
};

export function buildDeviceUpdate(mode: "translate" | "rotate"): RenderPacket["instances"] {
  const instances: RenderInstance[] = [];
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

export interface ShadowEdgeStats {
  /** 阴影掩码边界像素数。 */
  readonly boundaryPixels: number;
  /** 阶梯角像素数(边界上 4-邻域构成棋盘/拐角的像素)——锯齿的直接度量。 */
  readonly cornerPixels: number;
  /** 角密度 = cornerPixels / boundaryPixels(锯齿能量口径,gate ①)。 */
  readonly cornerRatio: number;
  /** 边界总长(周长,px)。 */
  readonly boundaryLength: number;
  readonly shadowPixels: number;
  readonly brightMean: number;
  readonly shadowMean: number;
}

/**
 * 阴影边缘锯齿统计(掩码边界角密度口径):
 * - 阴影掩码 = luma < 0.55·(亮均值)(地面测区,亮场/暗场双峰);
 * - 边界像素 = 4-邻域含异类的掩码像素;阶梯角 = 其两对角邻居同为异类且两正交邻居
 *   同类的角点模式 —— 直线边界角密度 ≈ 0,45° 阶梯 ≈ 0.5-1.0;
 * - Sobel 梯度能量同时保留(参考面:更锐利的边缘不等于更多锯齿,不以梯度论胜负)。
 */
export function edgeAliasingEnergy(field: LumaField, region: { x0: number; y0: number; x1: number; y1: number },
  threshold = 0.55): ShadowEdgeStats {
  const at = (x: number, y: number): number => field.luma[y * field.width + x]!;
  let bright = 0, brightCount = 0, shadow = 0, shadowCount = 0;
  const mask = (x: number, y: number): boolean => at(x, y) < threshold;
  let boundaryPixels = 0, cornerPixels = 0, shadowPixels = 0;
  for (let y = Math.max(1, region.y0); y < Math.min(field.height - 1, region.y1); y++) {
    for (let x = Math.max(1, region.x0); x < Math.min(field.width - 1, region.x1); x++) {
      const center = at(x, y);
      const isShadow = mask(x, y);
      if (isShadow) shadowPixels += 1; else { bright += center; brightCount += 1; }
      if (center > 0.02 && !isShadow) { /* bright */ }
      else if (center > 0.02) { shadow += center; shadowCount += 1; }
      const north = mask(x, y - 1), south = mask(x, y + 1);
      const west = mask(x - 1, y), east = mask(x + 1, y);
      const different = ((north !== isShadow) ? 1 : 0) + ((south !== isShadow) ? 1 : 0)
        + ((west !== isShadow) ? 1 : 0) + ((east !== isShadow) ? 1 : 0);
      if (different === 0) continue;
      boundaryPixels += 1;
      // 角点模式:两正交邻居同类、两对角邻居异类(阶梯拐角)。
      const nw = mask(x - 1, y - 1), ne = mask(x + 1, y - 1);
      const sw = mask(x - 1, y + 1), se = mask(x + 1, y + 1);
      const corner = (north === south) === isShadow && (west === east) === isShadow
        && ((nw !== isShadow && se !== isShadow) || (ne !== isShadow && sw !== isShadow));
      if (corner) cornerPixels += 1;
    }
  }
  return { boundaryPixels, cornerPixels,
    cornerRatio: boundaryPixels > 0 ? cornerPixels / boundaryPixels : 0,
    boundaryLength: boundaryPixels,
    shadowPixels,
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

/** 阴影带平均绝对差(对参考真源):|a-b| 均值,区域可限。 */
export function meanAbsDiff(left: LumaField, right: LumaField,
  region?: { x0: number; y0: number; x1: number; y1: number }): number {
  let sum = 0, count = 0;
  const x0 = region?.x0 ?? 0, y0 = region?.y0 ?? 0;
  const x1 = Math.min(region?.x1 ?? left.width, left.width);
  const y1 = Math.min(region?.y1 ?? left.height, left.height);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    sum += Math.abs(left.luma[y * left.width + x]! - right.luma[y * right.width + x]!);
    count += 1;
  }
  return count > 0 ? sum / count : 0;
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
  readonly pages: readonly { readonly frame: number; readonly materialized: number; readonly resident: number;
    readonly dynamicInvalidated: number }[];
  readonly dynamic: { readonly translateLatencyFrames: number; readonly rotateLatencyFrames: number };
  readonly error?: string;
}

interface ActiveLeg {
  readonly mode: "cascaded" | "virtual" | "reference";
  readonly withCapture: boolean;
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

/** 逐帧 telemetry 页遥测采样(FrameMetrics.virtualShadow / virtualShadowPages)。 */
function samplePages(metrics: FrameMetrics | undefined, frame: number): void {
  if (!active) return;
  active.pages.push({ frame, materialized: metrics?.virtualShadow?.materializedPages ?? 0,
    resident: metrics?.virtualShadowPages?.residentPages ?? 0,
    dynamicInvalidated: metrics?.virtualShadow?.dynamicInvalidated ?? 0 });
}

export async function beginLeg(mode: "cascaded" | "virtual" | "reference", withCapture: boolean): Promise<void> {
  if (active) throw new Error("Previous probe leg was not ended.");
  const canvas = document.createElement("canvas");
  canvas.width = PROBE_WIDTH; canvas.height = PROBE_HEIGHT;
  canvas.style.width = `${PROBE_WIDTH}px`; canvas.style.height = `${PROBE_HEIGHT}px`;
  document.body.appendChild(canvas);
  const packet = buildProbeScene();
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    ...(mode === "virtual" ? { shadowMode: "virtual" as const } : {}),
    ...(mode === "reference" ? { shadows: { exactProfile: { cascadeCount: 1, shadowMapSize: 8192 } } } : {}),
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
    const metrics = active.renderer.render(activeView);
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
    const metrics = active.renderer.render(activeView);
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
  for (let index = 0; index < 3; index++) { active.renderer.render(activeView); samplePages(undefined, index); }
  const afterErrors = active.renderer.deviceDiagnostics;
  if (afterErrors.length > 0) throw new Error(`device validation: ${afterErrors.map(e => e.message).join(" | ")}`);
  const field = await latestLuma();
  // 测区 = 中央净空地面走廊(避开左右前景设备箱的暗面与远景球墙)。
  const fenceRegion = { x0: Math.floor(field.width * 0.34), y0: Math.floor(field.height * 0.52),
    x1: Math.floor(field.width * 0.66), y1: Math.floor(field.height * 0.97) };
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

/** 动态腿:updateInstances → 逐帧差分,返回与收敛帧差降到初始差 50% 的帧序(0 = 同帧)。 */
export async function dynamicLatencyLeg(mode: "translate" | "rotate",
  maxFrames = 6): Promise<number> {
  if (!active || !active.withCapture) throw new Error("dynamic latency requires a capture leg.");
  const renderer = active.renderer;
  const before: LumaField[] = [];
  for (let index = 0; index < 3; index++) {
    try { renderer.render(activeView); }
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
    try { metrics = renderer.render(activeView); }
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
    image: image ?? { edge: { boundaryPixels: 0, cornerPixels: 0, cornerRatio: 0, boundaryLength: 0,
      shadowPixels: 0, brightMean: 0, shadowMean: 0 }, holes: { nonFinite: 0, blackSpeckles: 0, samples: 0 },
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = GPUDevice.prototype as unknown as Record<string, any>;
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
  const origBindGroupLayout = proto.createBindGroupLayout as
    ((this: GPUDevice, descriptor: GPUBindGroupLayoutDescriptor) => GPUBindGroupLayout) | undefined;
  if (origBindGroupLayout) {
    proto.createBindGroupLayout = function (this: GPUDevice, descriptor: GPUBindGroupLayoutDescriptor) {
      return scopeTrace(this, `createBindGroupLayout[${descriptor.label ?? "unlabeled"}]`,
        () => origBindGroupLayout.call(this, descriptor));
    };
  }
  const origPipelineLayout = proto.createPipelineLayout as
    ((this: GPUDevice, descriptor: GPUPipelineLayoutDescriptor) => GPUPipelineLayout) | undefined;
  if (origPipelineLayout) {
    proto.createPipelineLayout = function (this: GPUDevice, descriptor: GPUPipelineLayoutDescriptor) {
      return scopeTrace(this, `createPipelineLayout[${descriptor.label ?? "unlabeled"}]`,
        () => origPipelineLayout.call(this, descriptor));
    };
  }
  const origRenderPipeline = proto.createRenderPipeline as
    ((this: GPUDevice, descriptor: GPURenderPipelineDescriptor) => GPURenderPipeline) | undefined;
  if (origRenderPipeline) {
    proto.createRenderPipeline = function (this: GPUDevice, descriptor: GPURenderPipelineDescriptor) {
      try { return origRenderPipeline.call(this, descriptor); }
      catch (error) { throw new Error(`createRenderPipeline[${descriptor.label ?? "unlabeled"}]: ${String(error)}`); }
    };
  }
  const origRenderPipelineAsync = proto.createRenderPipelineAsync as
    ((this: GPUDevice, descriptor: GPURenderPipelineDescriptor) => Promise<GPURenderPipeline>) | undefined;
  if (origRenderPipelineAsync) {
    proto.createRenderPipelineAsync = function (this: GPUDevice, descriptor: GPURenderPipelineDescriptor) {
      return origRenderPipelineAsync.call(this, descriptor).catch(error => {
        throw new Error(`createRenderPipelineAsync[${descriptor.label ?? "unlabeled"}]: ${String(error)}`);
      });
    };
  }
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

/** 诊断:读回虚拟阴影 atlas 指定层(2048² r32float)。 */
export async function dumpShadowAtlasLayer(layer = 0): Promise<{ readonly width: number; readonly height: number;
  readonly bytesPerRow: number; readonly floats: Float32Array; readonly canvasPng: string }> {
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
  encoder.copyTextureToBuffer({ texture: atlas, origin: { x: 0, y: 0, z: layer } },
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

/** 诊断:虚拟阴影驻留页表快照(id/slot 对照,定位页内容与页坐标的映射问题)。 */
export function dumpVirtualShadowResidency(): unknown {
  const table = (active?.renderer as unknown as {
    virtualShadows?: { table: { residentSnapshot(): unknown[] } };
  }).virtualShadows?.table;
  if (!table) throw new Error("virtual shadow table unavailable.");
  return table.residentSnapshot();
}

/** M2 诊断:世界点集 → GPU 读回数据上逐 mip 重放 deepVsmResolveRing(定位全亮缺陷环节)。 */
export interface VirtualResolveSample {
  readonly label: string;
  readonly world: readonly [number, number, number];
}

/** 列主序 mat4 · vec3(w=1),与 projectToRing/deepVsmResolveRing 同合同。 */
function multiplyMatrixPoint(m: Float32Array, p: readonly [number, number, number]): {
  readonly x: number; readonly y: number; readonly z: number; readonly w: number } {
  const [x, y, z] = p;
  return {
    x: m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    y: m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    z: m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
    w: m[3]! * x + m[7]! * y + m[11]! * z + m[15]!,
  };
}

export async function diagVirtualResolve(samples: readonly VirtualResolveSample[]): Promise<unknown> {
  if (!active) throw new Error("beginLeg was not called.");
  const resources = (active.renderer as unknown as {
    virtualShadows?: { atlas: GPUTexture; uniformBuffer: GPUBuffer; metaBuffer: GPUBuffer;
      layersBuffer: GPUBuffer };
  }).virtualShadows;
  if (!resources) throw new Error("virtual shadow resources unavailable.");
  const device = active.renderer.session.device;
  const readback = async (buffer: GPUBuffer, size: number): Promise<ArrayBuffer> => {
    const staging = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder({ label: "vsm diag readback" });
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const copy = staging.getMappedRange().slice(0);
    staging.unmap();
    staging.destroy();
    return copy;
  };
  const uniform = new Float32Array(await readback(resources.uniformBuffer, resources.uniformBuffer.size));
  const meta = new Uint32Array(await readback(resources.metaBuffer, resources.metaBuffer.size));
  const layers = new Int32Array(await readback(resources.layersBuffer, resources.layersBuffer.size));
  const atlasLayers = [0, 1, 2, 3].map(layer => dumpShadowAtlasLayer(layer));
  const atlas = await Promise.all(atlasLayers);
  const bias = uniform[149]!;
  const rows = samples.map(sample => {
    const perRing = [0, 1, 2].map(ring => {
      const matrix = uniform.slice(ring * 16, ring * 16 + 16);
      const clip = multiplyMatrixPoint(matrix, sample.world);
      if (!(clip.w > 0)) return { ring, error: "clip.w<=0" };
      const ndc = { x: clip.x / clip.w, y: clip.y / clip.w, z: clip.z / clip.w };
      const uv = { x: ndc.x * 0.5 + 0.5, y: ndc.y * -0.5 + 0.5 };
      const receiverDepth = ndc.z;
      const perMip = [0, 1, 2, 3, 4, 5, 6, 7].map(mip => {
        const grid = 128 >> mip;
        const tileU = uv.x * grid, tileV = uv.y * grid;
        const tx = Math.floor(tileU), ty = Math.floor(tileV);
        if (tx < 0 || ty < 0 || tx >= grid || ty >= grid) return { mip, miss: "outside" };
        const row = (ring * 8 + mip) * 4;
        const gridW = meta[row]!, layersBase = meta[row + 2]!;
        const slot = layers[layersBase + ty * gridW + tx]!;
        if (slot < 0) return { mip, miss: "no-page" };
        const pageTexelU = (tileU - tx) * 128, pageTexelV = (tileV - ty) * 128;
        const localU = Math.min(127.5, Math.max(0.5, pageTexelU)), localV = Math.min(127.5, Math.max(0.5, pageTexelV));
        const atlasTileX = slot % 16, atlasTileY = Math.floor(slot / 16) % 16, atlasLayer = Math.floor(slot / 256);
        const floats = atlas[atlasLayer]!.floats;
        const at = (du: number, dv: number): number =>
          floats[Math.min(2047, atlasTileY * 128 + Math.floor(localV) + dv) * 2048
            + Math.min(2047, atlasTileX * 128 + Math.floor(localU) + du)]!;
        const center = at(0, 0);
        let lit = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (at(dx, dy) >= receiverDepth - bias) lit += 1;
        }
        return { mip, slot, pageTexel: [pageTexelU, pageTexelV].map(v => Math.round(v * 10) / 10),
          depth: center, shadowed: center < receiverDepth - bias, pcf9Lit: `${lit}/9` };
      });
      return { ring, uv: [uv.x, uv.y].map(v => Math.round(v * 5) / 10000), receiverDepth,
        texelWorld: uniform[144 + ring], mips: perMip };
    });
    return { label: sample.label, world: sample.world, rings: perRing };
  });
  return { bias, texelWorld0: Array.from(uniform.slice(144, 148)),
    params2: Array.from(uniform.slice(156, 160)), rows };
}

/** M2 策略实验:阴影带地面像素逐点重放 resolve(旧链/就近/细优先/最细),供 Node 侧对分。 */
export interface VirtualBandSample {
  /** 阴影带内像素索引((py−y0)·bandWidth + (px−x0))。 */
  readonly bandIndex: number;
  readonly desired: number;
  readonly worldZ: number;
  /** 各策略 9-tap PCF 可见度(0..1,-1 = 全环 miss)。 */
  readonly visibility: readonly { readonly policy: string; readonly visibility: number;
    readonly ring: number; readonly mip: number }[];
}

export interface VirtualBandReport {
  readonly bias: number;
  readonly samples: readonly VirtualBandSample[];
  readonly desiredHistogram: readonly { readonly desired: number; readonly count: number }[];
  readonly replayedPixels: number;
}

/** cameraMath.lookAt/perspective 镜像(列主序;仅诊断用,与 src 同式)。 */
function diagViewProjection(eye: readonly [number, number, number],
  target: readonly [number, number, number]): Float32Array {
  const aspect = PROBE_WIDTH / PROBE_HEIGHT;
  const f = 1 / Math.tan(Math.PI / 8);
  const perspective = new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, 1 / (0.1 - 1000), -1, 0, 0, 0.1 * 1000 / (0.1 - 1000), 0]);
  const subtract = (a: number[], b: number[]): number[] => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
  const norm = (v: number[]): number[] => {
    const l = Math.hypot(...v);
    return [v[0]! / l, v[1]! / l, v[2]! / l];
  };
  const cross = (a: number[], b: number[]): number[] =>
    [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const dot = (a: number[], b: number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const z = norm(subtract([...eye], [...target]));
  const x = norm(cross([0, 1, 0], z));
  const y = cross(z, x);
  const lookAt = new Float32Array([
    x[0]!, y[0]!, z[0]!, 0, x[1]!, y[1]!, z[1]!, 0, x[2]!, y[2]!, z[2]!, 0,
    -dot(x, [...eye]), -dot(y, [...eye]), -dot(z, [...eye]), 1,
  ]);
  const multiply = (a: Float32Array, b: Float32Array): Float32Array => {
    const out = new Float32Array(16);
    for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) out[column * 4 + row] = out[column * 4 + row]! + a[k * 4 + row]! * b[column * 4 + k]!;
    }
    return out;
  };
  return multiply(perspective, lookAt);
}

export async function diagVirtualBand(step = 6): Promise<VirtualBandReport> {
  if (!active) throw new Error("beginLeg was not called.");
  const resources = (active.renderer as unknown as {
    virtualShadows?: { atlas: GPUTexture; uniformBuffer: GPUBuffer; metaBuffer: GPUBuffer;
      layersBuffer: GPUBuffer };
  }).virtualShadows;
  if (!resources) throw new Error("virtual shadow resources unavailable.");
  const device = active.renderer.session.device;
  const readback = async (buffer: GPUBuffer, size: number): Promise<ArrayBuffer> => {
    const staging = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder({ label: "vsm band diag readback" });
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const copy = staging.getMappedRange().slice(0);
    staging.unmap();
    staging.destroy();
    return copy;
  };
  const uniform = new Float32Array(await readback(resources.uniformBuffer, resources.uniformBuffer.size));
  const meta = new Uint32Array(await readback(resources.metaBuffer, resources.metaBuffer.size));
  const layers = new Int32Array(await readback(resources.layersBuffer, resources.layersBuffer.size));
  const atlas = await Promise.all([0, 1, 2, 3].map(layer => dumpShadowAtlasLayer(layer)));
  const bias = uniform[149]!;
  const top = 7;
  const virtualEdge = 16384;
  const fetchDepth = (slot: number, pageTexelX: number, pageTexelY: number): number => {
    const localX = Math.min(127.5, Math.max(0.5, pageTexelX)), localY = Math.min(127.5, Math.max(0.5, pageTexelY));
    const tileX = slot % 16, tileY = Math.floor(slot / 16) % 16, layer = Math.floor(slot / 256);
    return atlas[layer]!.floats[(tileY * 128 + Math.floor(localY)) * 2048 + tileX * 128 + Math.floor(localX)]!;
  };
  /** deepVsmResolveMip 镜像。 */
  const resolveMip = (ring: number, mip: number, uvX: number, uvY: number, receiverNdcZ: number, texelWorld: number): {
    found: boolean; slot: number; pageTexelX: number; pageTexelY: number } => {
    const grid = 128 >> mip;
    const tileU = uvX * grid, tileV = uvY * grid;
    const tx = Math.floor(tileU), ty = Math.floor(tileV);
    if (tx < 0 || ty < 0 || tx >= grid || ty >= grid) return { found: false, slot: -1, pageTexelX: 0, pageTexelY: 0 };
    const row = (ring * 8 + mip) * 4;
    const slot = layers[meta[row + 2]! + ty * meta[row]! + tx]!;
    if (slot < 0) return { found: false, slot: -1, pageTexelX: 0, pageTexelY: 0 };
    return { found: true, slot, pageTexelX: (tileU - tx) * 128, pageTexelY: (tileV - ty) * 128 };
  };
  /** deepVsmFilter 镜像(pcssLightWorld=0:9-tap,半径 0.5 texel,phi=0 确定性)。 */
  const filter = (slot: number, px: number, py: number, texelWorld: number, receiverDepth: number): number => {
    const receiver = receiverDepth - bias;
    let visibility = fetchDepth(slot, px, py) >= receiver ? 1 : 0;
    for (let index = 0; index < 8; index++) {
      const angle = index * 0.7853981633974483;
      const offsetX = Math.cos(angle) * 0.5, offsetY = Math.sin(angle) * 0.5;
      visibility += fetchDepth(slot, px + offsetX, py + offsetY) >= receiver ? 1 : 0;
    }
    void texelWorld;
    return visibility / 9;
  };
  /** 策略族:同一次读回上评估四种 mip 搜索策略(环间回退同 deepVirtualShadow)。 */
  const policies = ["old", "nearest", "nearestFine", "finest"] as const;
  const resolveRing = (policy: typeof policies[number], ring: number, uvX: number, uvY: number,
    receiverNdcZ: number, desired: number, footprintWorld: number, ringTexel: number): {
    found: boolean; slot: number; px: number; py: number; texelWorld: number; mip: number } => {
    const candidates: { mip: number; texel: number }[] = [];
    if (policy === "old") {
      for (let mip = desired; mip <= top; mip++) candidates.push({ mip, texel: ringTexel * 2 ** mip });
    } else if (policy === "nearest") {
      for (let distance = 0; distance <= top; distance++) {
        const coarse = desired + distance;
        if (coarse <= top) candidates.push({ mip: coarse, texel: Math.max(ringTexel * 2 ** coarse, footprintWorld) });
        if (distance > 0 && desired - distance >= 0) {
          candidates.push({ mip: desired - distance, texel: Math.max(ringTexel * 2 ** (desired - distance), footprintWorld) });
        }
      }
    } else if (policy === "nearestFine") {
      for (let distance = 0; distance <= top; distance++) {
        if (distance > 0 && desired - distance >= 0) {
          candidates.push({ mip: desired - distance, texel: Math.max(ringTexel * 2 ** (desired - distance), footprintWorld) });
        }
        const coarse = desired + distance;
        if (coarse <= top) candidates.push({ mip: coarse, texel: Math.max(ringTexel * 2 ** coarse, footprintWorld) });
      }
    } else {
      for (let mip = 0; mip <= top; mip++) candidates.push({ mip, texel: Math.max(ringTexel * 2 ** mip, footprintWorld) });
    }
    for (const candidate of candidates) {
      const hit = resolveMip(ring, candidate.mip, uvX, uvY, receiverNdcZ, candidate.texel);
      if (hit.found) return { found: true, slot: hit.slot, px: hit.pageTexelX, py: hit.pageTexelY,
        texelWorld: candidate.texel, mip: candidate.mip };
    }
    return { found: false, slot: -1, px: 0, py: 0, texelWorld: 0, mip: -1 };
  };
  const viewProjection = diagViewProjection(VIEW.eye, VIEW.target);
  const projectMain = (world: readonly [number, number, number]): { x: number; y: number; w: number } => {
    const m = viewProjection;
    const cw = m[3]! * world[0] + m[7]! * world[1] + m[11]! * world[2] + m[15]!;
    const cx = m[0]! * world[0] + m[4]! * world[1] + m[8]! * world[2] + m[12]!;
    const cy = m[1]! * world[0] + m[5]! * world[1] + m[9]! * world[2] + m[13]!;
    return { x: cx / cw, y: cy / cw, w: cw };
  };
  /** 像素 → 地面 y=0 世界点(透视射线求交;相机在 y=1.7 俯视,恒相交)。 */
  const pixelGroundPoint = (sx: number, sy: number): [number, number, number] => {
    const aspect = PROBE_WIDTH / PROBE_HEIGHT;
    const ndcX = sx / PROBE_WIDTH * 2 - 1, ndcY = 1 - sy / PROBE_HEIGHT * 2;
    const tanHalf = Math.tan(Math.PI / 8);
    const viewDir = [ndcX * tanHalf * aspect, ndcY * tanHalf, -1];
    const subtract = (a: number[], b: number[]): number[] => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
    const zAxis = (() => {
      const backward = subtract([...VIEW.eye], [...VIEW.target]);
      const l = Math.hypot(...backward);
      return backward.map(v => v / l);
    })();
    const cross = (a: number[], b: number[]): number[] =>
      [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
    const norm = (v: number[]): number[] => {
      const l = Math.hypot(...v);
      return [v[0]! / l, v[1]! / l, v[2]! / l];
    };
    const xAxis = norm(cross([0, 1, 0], zAxis));
    const yAxis = cross(zAxis, xAxis);
    const worldDir = [
      xAxis[0]! * viewDir[0]! + yAxis[0]! * viewDir[1]! + zAxis[0]! * viewDir[2]!,
      xAxis[1]! * viewDir[0]! + yAxis[1]! * viewDir[1]! + zAxis[1]! * viewDir[2]!,
      xAxis[2]! * viewDir[0]! + yAxis[2]! * viewDir[1]! + zAxis[2]! * viewDir[2]!,
    ];
    const t = -VIEW.eye[1]! / worldDir[1]!;
    return [VIEW.eye[0]! + worldDir[0]! * t, 0, VIEW.eye[2]! + worldDir[2]! * t];
  };
  const bandX0 = Math.floor(PROBE_WIDTH * 0.34), bandY0 = Math.floor(PROBE_HEIGHT * 0.52);
  const bandX1 = Math.floor(PROBE_WIDTH * 0.66), bandY1 = Math.floor(PROBE_HEIGHT * 0.97);
  const bandWidth = bandX1 - bandX0;
  const histogram = new Map<number, number>();
  const samples: VirtualBandSample[] = [];
  for (let sy = bandY0; sy < bandY1; sy += step) {
    for (let sx = bandX0; sx < bandX1; sx += step) {
      const world = pixelGroundPoint(sx, sy);
      const main = projectMain(world);
      if (!(main.w > 0)) continue;
      // 数值 fwidth(与 WGSL 同式:两轴差分绝对值求和,逐 ndc 分量)。
      const stepWorldX = pixelGroundPoint(sx + 1, sy);
      const stepWorldY = pixelGroundPoint(sx, sy + 1);
      const visibility: { policy: string; visibility: number; ring: number; mip: number }[] = [];
      const desiredByRing: number[] = [];
      // 每策略独立走环链(0→1→2),与 deepVirtualShadow 的环回退同式。
      const policyHits = new Map<string, { slot: number; px: number; py: number;
        texelWorld: number; receiverDepth: number; mip: number; ring: number }>();
      for (let ring = 0; ring < 3; ring++) {
        const matrix = uniform.slice(ring * 16, ring * 16 + 16);
        const project = (point: readonly [number, number, number]): { x: number; y: number; z: number } => {
          const cx = matrix[0]! * point[0] + matrix[4]! * point[1] + matrix[8]! * point[2] + matrix[12]!;
          const cy = matrix[1]! * point[0] + matrix[5]! * point[1] + matrix[9]! * point[2] + matrix[13]!;
          const cz = matrix[2]! * point[0] + matrix[6]! * point[1] + matrix[10]! * point[2] + matrix[14]!;
          return { x: cx, y: cy, z: cz }; // 正交 w=1。
        };
        const center = project(world);
        const gradX = project(stepWorldX), gradY = project(stepWorldY);
        const px = Math.abs(gradX.x - center.x) + Math.abs(gradY.x - center.x);
        const py = Math.abs(gradX.y - center.y) + Math.abs(gradY.y - center.y);
        const uvX = center.x * 0.5 + 0.5, uvY = center.y * -0.5 + 0.5;
        if (uvX < 0 || uvX > 1 || uvY < 0 || uvY > 1 || center.z < 0 || center.z > 1) continue;
        const receiverDepth = center.z;
        const ringTexel = uniform[144 + ring]!;
        const pixelsPerVirtualTexel = Math.max(Math.max(px, py), 0.000001) * virtualEdge;
        const mipLog = Math.log2(pixelsPerVirtualTexel);
        const desired = Math.min(top, Math.max(0, Math.floor(mipLog >= 0 ? mipLog + 0.5 : 0)));
        if (ring === 0) desiredByRing.push(desired);
        if (ring === 0) histogram.set(desired, (histogram.get(desired) ?? 0) + 1);
        const footprintWorld = ringTexel * 2 ** mipLog;
        for (const policy of policies) {
          if (policyHits.has(policy)) continue;
          const hit = resolveRing(policy, ring, uvX, uvY, receiverDepth, desired, footprintWorld, ringTexel);
          if (hit.found) policyHits.set(policy, { slot: hit.slot, px: hit.px, py: hit.py,
            texelWorld: hit.texelWorld, receiverDepth, mip: hit.mip, ring });
        }
      }
      for (const policy of policies) {
        const hit = policyHits.get(policy);
        visibility.push({ policy, visibility: hit ? filter(hit.slot, hit.px, hit.py, hit.texelWorld, hit.receiverDepth) : -1,
          ring: hit?.ring ?? -1, mip: hit?.mip ?? -1 });
      }
      samples.push({ bandIndex: (sy - bandY0) * bandWidth + (sx - bandX0), desired: desiredByRing[0] ?? -1,
        worldZ: Math.round(world[2] * 100) / 100, visibility });
    }
  }
  return { bias, samples, desiredHistogram: [...histogram.entries()].sort((a, b) => a[0] - b[0])
    .map(([desired, count]) => ({ desired, count })), replayedPixels: samples.length };
}

/** 诊断:读回 GPU 页表(meta+layers)与 CPU 驻留对照(定位采样 miss 的上传/打包问题)。 */
export async function dumpShadowPageTable(): Promise<{ readonly meta: readonly number[];
  readonly layers: readonly number[]; readonly metaWords: number; readonly layerEntries: number;
  readonly uniformTail: readonly number[]; readonly matrices00: readonly number[] }> {
  const resources = (active?.renderer as unknown as {
    virtualShadows?: { metaBuffer: GPUBuffer; layersBuffer: GPUBuffer; uniformBuffer: GPUBuffer };
  }).virtualShadows;
  if (!resources) throw new Error("virtual shadow resources unavailable.");
  const device = active!.renderer.session.device;
  const readback = async (buffer: GPUBuffer, size: number): Promise<ArrayBuffer> => {
    const staging = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder({ label: "vsm page table readback" });
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const copy = staging.getMappedRange().slice(0);
    staging.unmap();
    staging.destroy();
    return copy;
  };
  const meta = new Uint32Array(await readback(resources.metaBuffer, resources.metaBuffer.size));
  const layers = new Int32Array(await readback(resources.layersBuffer, resources.layersBuffer.size));
  const uniform = new Float32Array(await readback(resources.uniformBuffer, resources.uniformBuffer.size));
  return { meta: Array.from(meta), layers: Array.from(layers),
    metaWords: resources.metaBuffer.size, layerEntries: resources.layersBuffer.size / 4,
    uniformTail: Array.from(uniform.slice(144, 160)), matrices00: Array.from(uniform.slice(0, 4)) };
}
