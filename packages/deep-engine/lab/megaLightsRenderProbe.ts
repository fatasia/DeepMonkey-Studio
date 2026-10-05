/// <reference types="@webgpu/types" />
// B2 MegaLights 生产全链渲染级 harness 探针(scripts/megaLightsRenderHarness.mjs 驱动;
// 惯例沿 lab/megaLightsGpuProbe.ts + scripts/sdf-gi-gpu.mjs)。
//
// 生产保真:真 DeviceSession + 真 PbrRenderer(生产默认 features:MSAA4/TAA/AO/bloom/
// vignette/contactShadows 全开)+ 生产 RenderPacket 批次 + RenderView 世界灯;MegaLights
// 四段(表面重建→RIS 两趟→加性合成)经 pbrRendererFrames 生产 dispatch 挂主 encoder,
// 像素读回走 present-color 白名单读回链(frameCapture readbacks)。本文件不触碰
// webgpu/pbrShader|pipelines|pbrPipelineSet|pbrRendererFrames(互斥域,只消费)。
//
// 腿:
//   A  整帧 perf:5000 动态点光(10% 移动)@1920×1080,features.megaLights=true,
//      墙钟(render→submit→onSubmittedWorkDone)+ GPU timestamp(gpuPassTiming 全帧
//      跨度 milliseconds)双口径 p50/p95;
//   A2 同场景同灯 features.megaLights=false 关臂:整帧 − A2 ≈ MegaLights 四段生产增量;
//      兼证 5000 灯关臂(簇光回退档)可运行;
//   B  像素正确性:左半场 5000 静态灯,读回 present-color,亮/暗区对比 + NaN/饱和哨兵
//      + 线性域 PNG 截图;
//   C  开关关逐位一致:40 灯(簇光预算内,megaLightsFramePlanned=false 零 dispatch)
//      双臂 features.megaLights true/false 逐帧 present-color 字节对比;
//   D  预算降级:resolutionScalePolicy targetFrameMs=1(harness 强制值;生产默认 16.67)
//      → 内部分辨率真实降档 + FrameMetrics.resolutionScale 披露 + 降档帧 PNG;
//   D2 池容量 fail-closed:MegaLightsFrameController.encodeFrame 超 MAX_MEGA_LIGHTS 拒绝。
//
// 证据:test-output/megaLights-render-20261005/(runner 落盘 acceptance.json + PNG)。
import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import type { FrameMetrics, PbrRendererOptions, RenderView } from "../src/webgpu/pbrRendererTypes.js";
import { isPbrFrameReadbackSnapshot, type PbrFrameReadbackResult } from "../src/webgpu/pbrFrameCaptureReadback.js";
import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import type { PbrMaterial, RenderPacket } from "../src/renderPacket.js";
import { MAX_MEGA_LIGHTS, resolveDirectLightingPath } from "../src/lighting/megaLights.js";
import { MegaLightsFrameController } from "../src/lighting/megaLightsFrameController.js";
import type { WorldClusteredLights, WorldPointLight } from "../src/lighting/worldLights.js";
import type { LightVector3 } from "../src/lighting/types.js";

// ---- 常量(与 M2 验收同口径) ----

const FULL_WIDTH = 1920;
const FULL_HEIGHT = 1080;
const BITWISE_WIDTH = 640;
const BITWISE_HEIGHT = 360;
const PERF_LIGHT_COUNT = 5000;
const PERF_WARM_FRAMES = 10;
const PERF_TIMED_FRAMES = 120;

/** 场景几何:一个房间(地面/三墙)+ 中隔墙(把左右半场分开,像素腿的亮暗对照)+ 两个箱体。 */
function roomPacket(): RenderPacket {
  const box = (min: readonly [number, number, number], max: readonly [number, number, number]): {
    vertices: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> } => {
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    const corners: readonly (readonly number[])[] = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    // 六面,每面 4 顶点(位置 + 显式面法线),两三角。
    const faces: readonly (readonly [readonly [number, number, number, number], readonly [number, number, number]])[] = [
      [[4, 5, 6, 7], [0, 0, 1]], [[1, 0, 3, 2], [0, 0, -1]], [[5, 1, 2, 6], [1, 0, 0]],
      [[0, 4, 7, 3], [-1, 0, 0]], [[7, 6, 2, 3], [0, 1, 0]], [[0, 1, 5, 4], [0, -1, 0]]];
    const vertices: number[] = [];
    const indices: number[] = [];
    for (const [cornerIds, normal] of faces) {
      const base = vertices.length / 6;
      for (const id of cornerIds) {
        vertices.push(corners[id]![0]!, corners[id]![1]!, corners[id]![2]!, normal[0], normal[1], normal[2]);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return { vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) };
  };
  const floor = box([-7, -0.5, -4.2], [7, 0, 1.2]);
  const backWall = box([-7, 0, -4.2], [7, 3.2, -3.9]);
  const leftWall = box([-7, 0, -4.2], [-6.7, 3.2, 1.2]);
  const rightWall = box([6.7, 0, -4.2], [7, 3.2, 1.2]);
  const divider = box([-0.15, 0, -3.9], [0.15, 2.8, 0.8]);
  const crateLeft = box([-4.6, 0, -1.6], [-3.4, 1.1, -0.4]);
  const crateRight = box([3.4, 0, -1.6], [4.6, 1.1, -0.4]);
  const meshes = [floor, backWall, leftWall, rightWall, divider, crateLeft, crateRight];
  const materials: readonly Omit<PbrMaterial, "id">[] = [
    { baseColor: [0.52, 0.52, 0.5], metallic: 0, roughness: 0.65 },
    { baseColor: [0.42, 0.42, 0.44], metallic: 0, roughness: 0.7 },
    { baseColor: [0.4, 0.4, 0.42], metallic: 0, roughness: 0.7 },
    { baseColor: [0.4, 0.4, 0.42], metallic: 0, roughness: 0.7 },
    { baseColor: [0.78, 0.78, 0.76], metallic: 0, roughness: 0.45 },
    { baseColor: [0.55, 0.35, 0.22], metallic: 0, roughness: 0.6 },
    { baseColor: [0.22, 0.35, 0.55], metallic: 0, roughness: 0.6 },
  ];
  return {
    geometries: meshes.map((mesh, index) => ({ id: `mega-room-${index}`, revision: 0, ...mesh })),
    materials: materials.map((material, index) => ({ id: `mega-mat-${index}`, ...material })),
    instances: meshes.map((_, index) => ({ id: `mega-inst-${index}`, geometry: `mega-room-${index}`,
      material: `mega-mat-${index}`, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] })),
  };
}

/** 确定性哈希散点(无随机源;两臂/两次运行字节可比)。 */
function hashUnit(index: number, salt: number): number {
  const value = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

/** 世界系点光阵(leg A/A2/D:全场景;leg B:仅左半场,与中隔墙构成亮暗对照)。 */
function buildLights(count: number, frame: number, xRange: readonly [number, number]): WorldClusteredLights {
  const points: WorldPointLight[] = [];
  const [xMin, xMax] = xRange;
  for (let index = 0; index < count; index++) {
    const moving = index % 10 === 0;
    const wobble = moving ? Math.sin(frame * 0.07 + index) * 0.5 : 0;
    const positionWorld: LightVector3 = [
      xMin + (xMax - xMin) * hashUnit(index, 1) + wobble,
      0.35 + 1.9 * hashUnit(index, 2),
      -3.8 + 4.4 * hashUnit(index, 3)];
    points.push({
      positionWorld,
      range: 3.2,
      color: [1, 0.92 - hashUnit(index, 4) * 0.12, 0.82 - hashUnit(index, 5) * 0.2],
      intensity: 0.7 + hashUnit(index, 6) * 1.3,
      decay: 2,
    });
  }
  return { points };
}

function renderView(width: number, height: number, lights: WorldClusteredLights): RenderView {
  return {
    eye: [0, 1.7, 4.4], target: [0, 0.7, -2], up: [0, 1, 0], extent: 14,
    background: [0.016, 0.016, 0.02], floor: [0.05, 0.05, 0.055], exposure: 1, roughness: 0.5,
    width, height, pixelRatio: 1, lights, verticalFovRadians: Math.PI / 3,
  };
}

// ---- 渲染器会话(真 DeviceSession + 真 PbrRenderer) ----

interface PbrReadback { readonly resourceId: string; readonly width: number; readonly height: number;
  readonly bytesPerRow: number; readonly bytes: Uint8Array }

interface LegSession {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: PbrRenderer;
  readonly errors: string[];
  /** 每帧 present-color 读回 promise(render 后压入;frameReadbackResults 指向本帧)。 */
  readonly readbacks: Promise<readonly PbrFrameReadbackResult[] | undefined>[];
  dispose(): void;
}

function frameCaptureOptions(): Pick<PbrRendererOptions, "frameCapture"> {
  const session = new FrameCaptureSession({ budget: { maxFrames: 512 } });
  return { frameCapture: { session,
    readbacks: { requests: [{ resourceId: "present-color" }], maxBytesPerFrame: 24 * 1024 * 1024 } } };
}

async function openLeg(canvasWidth: number, canvasHeight: number,
  options: PbrRendererOptions, attach: boolean): Promise<LegSession> {
  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  if (attach) {
    canvas.id = "megalights-harness-canvas";
    document.body.appendChild(canvas);
  }
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, options);
  renderer.setPacket(roomPacket()); // 生产批次发布先于首帧(空场景帧会让像素腿退化为纯背景)。
  const errors: string[] = [];
  renderer.session.device.addEventListener("uncapturederror", event => {
    errors.push((event as GPUUncapturedErrorEvent).error.message);
  });
  return {
    canvas, renderer, errors, readbacks: [],
    dispose: () => { renderer.dispose(); canvas.remove(); },
  };
}

/** 生产帧循环:render →(可选)压入本帧 present-color 读回 → onSubmittedWorkDone 完成墙钟。 */
async function runFrames(leg: LegSession, view: RenderView, frames: number,
  collectReadbacks: boolean): Promise<{ readonly wallMs: number[]; readonly gpuFrameMs: number[];
    readonly cpuSubmitMs: number[]; readonly metrics: FrameMetrics[] }> {
  const wallMs: number[] = [];
  const gpuFrameMs: number[] = [];
  const cpuSubmitMs: number[] = [];
  const metricsHistory: FrameMetrics[] = [];
  for (let frame = 0; frame < frames; frame++) {
    const start = performance.now();
    const metrics = leg.renderer.render(view);
    const encoded = performance.now();
    await leg.renderer.session.device.queue.onSubmittedWorkDone();
    const done = performance.now();
    if (!metrics) throw new Error(`render() returned no metrics at frame ${frame}.`);
    if (collectReadbacks) {
      const pending = leg.renderer.frameReadbackResults;
      (leg.readbacks as unknown as unknown[]).push(pending ?? Promise.resolve(undefined));
    }
    wallMs.push(done - start);
    cpuSubmitMs.push(encoded - start);
    if (metrics.gpuPassTimings?.availability === "measured"
      && typeof metrics.gpuPassTimings.milliseconds === "number") {
      gpuFrameMs.push(metrics.gpuPassTimings.milliseconds);
    }
    metricsHistory.push(metrics);
    if (leg.renderer.session.hasErrors) throw new Error("device session reported errors during frames.");
  }
  return { wallMs, gpuFrameMs, cpuSubmitMs, metrics: metricsHistory };
}

function percentileOf(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

function timingSummary(values: readonly number[]): Record<string, number> {
  return { samples: values.length, p50: percentileOf(values, 0.5), p95: percentileOf(values, 0.95),
    max: Math.max(...values), mean: values.reduce((total, value) => total + value, 0) / values.length };
}

// ---- f16 解码与线性域统计 ----

function decodeHalf(raw: number): number {
  const exponent = (raw & 0x7c00) >> 10, fraction = raw & 0x03ff;
  if (exponent === 0) return (raw & 0x8000 ? -1 : 1) * fraction * 5.960464477539063e-8;
  if (exponent === 0x1f) return (raw & 0x8000 ? -1 : 1) * (fraction ? NaN : Infinity);
  return (raw & 0x8000 ? -1 : 1) * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

interface DecodedFrame {
  readonly width: number; readonly height: number;
  /** 行主序 RGBA 线性 f32(解 f16;bytesPerRow 对齐已剥离)。 */
  readonly rgba: Float32Array<ArrayBuffer>;
}

function decodeReadback(readback: PbrReadback): DecodedFrame {
  const rgba = new Float32Array(readback.width * readback.height * 4);
  const words = new Uint16Array(readback.bytes.buffer, readback.bytes.byteOffset,
    readback.bytes.byteLength >> 1);
  const stride = readback.bytesPerRow >> 1;
  for (let y = 0; y < readback.height; y++) {
    for (let x = 0; x < readback.width; x++) {
      const source = y * stride + x * 4;
      const target = (y * readback.width + x) * 4;
      rgba[target] = decodeHalf(words[source]!);
      rgba[target + 1] = decodeHalf(words[source + 1]!);
      rgba[target + 2] = decodeHalf(words[source + 2]!);
      rgba[target + 3] = decodeHalf(words[source + 3]!);
    }
  }
  return { width: readback.width, height: readback.height, rgba };
}

function regionMeanLuminance(image: DecodedFrame,
  region: readonly [number, number, number, number]): number {
  const [x0, x1, y0, y1] = region;
  let total = 0, count = 0;
  for (let y = Math.floor(y0 * image.height); y < Math.floor(y1 * image.height); y++) {
    for (let x = Math.floor(x0 * image.width); x < Math.floor(x1 * image.width); x++) {
      const base = (y * image.width + x) * 4;
      total += 0.2126 * image.rgba[base]! + 0.7152 * image.rgba[base + 1]! + 0.0722 * image.rgba[base + 2]!;
      count++;
    }
  }
  return total / Math.max(count, 1);
}

/** 线性 HDR → PNG(Reinhard 色调映射 + gamma;gain 供低增益结构图;确定性)。 */
async function pngFromLinear(image: DecodedFrame, gain = 1): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2d context unavailable for PNG encoding.");
  const imageData = context.createImageData(image.width, image.height);
  for (let index = 0; index < image.width * image.height; index++) {
    const base = index * 4;
    for (let channel = 0; channel < 3; channel++) {
      const linear = Math.max(image.rgba[base + channel]! * gain, 0);
      imageData.data[index * 4 + channel] = Math.round(Math.sqrt(linear / (1 + linear)) * 255);
    }
    imageData.data[index * 4 + 3] = 255;
  }
  context.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

async function latestPresentColor(leg: LegSession): Promise<PbrReadback> {
  const results = await leg.readbacks[leg.readbacks.length - 1];
  if (!results) throw new Error("frame readback results were not produced (capture not open?).");
  const snapshot = results.find(isPbrFrameReadbackSnapshot);
  if (!snapshot) {
    const unavailable = results.find(result => !isPbrFrameReadbackSnapshot(result)) as
      { reason?: string } | undefined;
    throw new Error(`present-color readback unavailable: ${unavailable?.reason ?? "missing"}`);
  }
  return snapshot;
}

// ---- 腿 A / A2:整帧 perf 双口径 + 关臂增量 ----

const SCENE_OPTIONS: PbrRendererOptions = {
  features: { megaLights: true, groundPlane: false, groundGrid: false },
};

async function fullFrameLeg(megaLights: boolean): Promise<Record<string, unknown>> {
  const leg = await openLeg(FULL_WIDTH, FULL_HEIGHT, {
    features: { ...SCENE_OPTIONS.features, megaLights }, gpuPassTiming: true }, false);
  try {
    let frame = 0;
    const viewFor = (): RenderView => renderView(FULL_WIDTH, FULL_HEIGHT,
      buildLights(PERF_LIGHT_COUNT, frame++, [-6, 6]));
    await runFrames(leg, viewFor(), PERF_WARM_FRAMES, false);
    const timed = await runFrames(leg, viewFor(), PERF_TIMED_FRAMES, false);
    const last = timed.metrics[timed.metrics.length - 1]!;
    const first = timed.metrics[0]!;
    return {
      megaLightsEnabled: megaLights,
      width: last.width, height: last.height,
      wall: timingSummary(timed.wallMs),
      gpuTimestamp: timed.gpuFrameMs.length ? timingSummary(timed.gpuFrameMs)
        : { samples: 0, note: first.gpuPassTimings?.unavailableReason ?? "gpu pass timing unavailable" },
      cpuEncodeSubmit: timingSummary(timed.cpuSubmitMs),
      megaLightsMetrics: last.megaLights,
      msaa: last.msaa,
      lightCount: last.lightCount,
      drawCalls: last.drawCalls,
      uncapturedErrors: leg.errors.slice(0, 8),
    };
  } finally { leg.dispose(); }
}

// ---- 腿 B:像素正确性(present-color 读回) ----

/** 像素腿渲染器保活句柄(页面截图发生在存续期内;截图后经 releasePixelLeg 释放)。 */
let pixelLegSession: LegSession | undefined;

const REGION = {
  litFloor: [0.1, 0.4, 0.55, 0.85],
  darkFloor: [0.6, 0.9, 0.55, 0.85],
  litNearDivider: [0.4, 0.49, 0.55, 0.85],
  darkNearDivider: [0.51, 0.6, 0.55, 0.85],
} as const;

async function pixelLeg(): Promise<Record<string, unknown>> {
  // 渲染器保活到 runner 页面截图之后(runner 调 releasePixelLeg 释放);
  // dispose 后合成器会丢弃呈现内容,截图必须发生在存续期内。
  pixelLegSession = await openLeg(FULL_WIDTH, FULL_HEIGHT,
    { ...SCENE_OPTIONS, ...frameCaptureOptions() }, true);
  const leg = pixelLegSession;
  try {
    const view = renderView(FULL_WIDTH, FULL_HEIGHT, buildLights(PERF_LIGHT_COUNT, 0, [-6.5, -0.7]));
    const run = await runFrames(leg, view, 60, true);
    const snapshot = await latestPresentColor(leg);
    const image = decodeReadback(snapshot);
    const pixels = image.width * image.height;
    let nanPixels = 0, litPixels = 0, saturated = 0, totalLuminance = 0;
    for (let index = 0; index < pixels; index++) {
      const base = index * 4;
      const r = image.rgba[base]!, g = image.rgba[base + 1]!, b = image.rgba[base + 2]!;
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) nanPixels++;
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      totalLuminance += luminance;
      if (luminance > 0.02) litPixels++;
      if (r > 24 || g > 24 || b > 24) saturated++;
    }
    const regions = Object.fromEntries(Object.entries(REGION).map(([name, rect]) =>
      [name, regionMeanLuminance(image, rect)])) as Record<keyof typeof REGION, number>;
    const litOverDark = regions.litFloor / Math.max(regions.darkFloor, 1e-6);
    const litNearOverDarkNear = regions.litNearDivider / Math.max(regions.darkNearDivider, 1e-6);
    const mega = run.metrics[run.metrics.length - 1]!.megaLights;
    return {
      width: image.width, height: image.height,
      meanLuminance: totalLuminance / pixels,
      nanPixels, litFraction: litPixels / pixels, saturatedFraction: saturated / pixels,
      regions, litOverDark, litNearOverDarkNear,
      megaLightsMetrics: mega,
      pngDataUrl: await pngFromLinear(image),
      pngExposureDataUrl: await pngFromLinear(image, 0.004),
      gates: {
        lightsVisible: totalLuminance / pixels > 0.002 && litPixels / pixels > 0.1,
        noNan: nanPixels === 0,
        occlusionContrast: litOverDark >= 1.5 && litNearOverDarkNear >= 1.5,
        dispatched: (mega?.dispatchedFrames ?? 0) > 0,
      },
      uncapturedErrors: leg.errors.slice(0, 8),
    };
  } catch (error) {
    leg.dispose();
    pixelLegSession = undefined;
    throw error;
  }
}

/** runner 页面截图完成后调用:释放保活的像素腿渲染器。 */
export async function releasePixelLeg(): Promise<void> {
  pixelLegSession?.dispose();
  pixelLegSession = undefined;
}

// ---- 腿 C:开关关逐位一致(features.megaLights false vs true 关臂基线) ----

async function collectPresentBytes(megaLights: boolean, frames: number): Promise<Uint8Array[]> {
  const leg = await openLeg(BITWISE_WIDTH, BITWISE_HEIGHT,
    { features: { ...SCENE_OPTIONS.features, megaLights }, ...frameCaptureOptions() }, false);
  try {
    const view = renderView(BITWISE_WIDTH, BITWISE_HEIGHT, buildLights(40, 0, [-6, 6]));
    await runFrames(leg, view, frames, true);
    const bytes: Uint8Array[] = [];
    for (const pending of leg.readbacks) {
      const results = await pending;
      const snapshot = results?.find(isPbrFrameReadbackSnapshot);
      if (!snapshot) throw new Error("bitwise leg missing present-color snapshot.");
      bytes.push(new Uint8Array(snapshot.bytes));
    }
    return bytes;
  } finally { leg.dispose(); }
}

async function bitwiseLeg(): Promise<Record<string, unknown>> {
  const frames = 10;
  const decision = resolveDirectLightingPath({ points: 40, spots: 0 });
  const on = await collectPresentBytes(true, frames);
  const off = await collectPresentBytes(false, frames);
  const perFrame = on.map((bytes, index) => {
    const other = off[index]!;
    let diffBytes = 0, firstDivergence = -1;
    if (bytes.length === other.length) {
      for (let offset = 0; offset < bytes.length; offset++) {
        if (bytes[offset] !== other[offset]) {
          diffBytes++;
          if (firstDivergence < 0) firstDivergence = offset;
        }
      }
    }
    return { frame: index + 1, byteLength: bytes.length, lengthEqual: bytes.length === other.length,
      diffBytes, firstDivergence };
  });
  const totalDiff = perFrame.reduce((total, frame) => total + frame.diffBytes, 0);
  return {
    sceneLights: 40, frames, pathDecision: decision,
    perFrame,
    totalDiffBytes: totalDiff,
    bitwiseIdentical: totalDiff === 0 && perFrame.every(frame => frame.lengthEqual),
    note: "40 灯在簇光预算(64)内 → megaLightsFramePlanned=false 零 dispatch,双臂帧命令流一致;"
      + "present-color 逐字节一致即关臂零变化证明。",
  };
}

// ---- 腿 D:预算降级(动态内部分辨率)真实触发 ----

async function budgetDegradationLeg(): Promise<Record<string, unknown>> {
  const leg = await openLeg(FULL_WIDTH, FULL_HEIGHT, {
    ...SCENE_OPTIONS,
    gpuPassTiming: true,
    // targetFrameMs=1 为 harness 强制值(生产默认 16.67):保证帧时间真实超限,触发生产
    // T07 降档决策链(非桩);缩减经 FrameMetrics.resolutionScale 披露(提示),链尾产出
    // 降档帧 present-color PNG 证 MegaLights 合成在降档分辨率下仍工作。
    resolutionScalePolicy: { targetFrameMs: 1, hysteresisMs: 0, minScale: 0.6, maxScale: 1,
      downStep: 0.08, upStep: 0.04, upHoldFrames: 12, quantize: 1 / 32 },
    ...frameCaptureOptions(),
  }, false);
  try {
    let frame = 0;
    const viewFor = (): RenderView => renderView(FULL_WIDTH, FULL_HEIGHT,
      buildLights(PERF_LIGHT_COUNT, frame++, [-6, 6]));
    const run = await runFrames(leg, viewFor(), 30, true);
    const timeline = run.metrics.map(metrics => ({
      frame: metrics.frame,
      scale: metrics.resolutionScale?.scale ?? 1,
      revision: metrics.resolutionScale?.revision ?? 0,
      internalWidth: metrics.resolutionScale?.internalWidth ?? metrics.width,
      internalHeight: metrics.resolutionScale?.internalHeight ?? metrics.height,
      dispatched: metrics.megaLights?.dispatchedFrames ?? 0,
    }));
    const snapshot = await latestPresentColor(leg);
    const png = await pngFromLinear(decodeReadback(snapshot));
    const degraded = timeline.filter(entry => entry.scale < 1);
    const last = run.metrics[run.metrics.length - 1]!;
    return {
      frames: run.metrics.length,
      scaleTimeline: timeline,
      degradedFrames: degraded.length,
      finalScale: degraded.at(-1)?.scale ?? 1,
      finalInternal: degraded.at(-1)
        ? { width: degraded.at(-1)!.internalWidth, height: degraded.at(-1)!.internalHeight }
        : { width: last.width, height: last.height },
      megaLightsMetrics: last.megaLights,
      pngDataUrl: png,
      gates: {
        degradationTriggered: degraded.length > 0,
        megaLightsStillDispatching: (last.megaLights?.dispatchedFrames ?? 0) === run.metrics.length,
        disclosedInMetrics: degraded.some(entry => entry.revision > 0),
      },
      uncapturedErrors: leg.errors.slice(0, 8),
    };
  } finally { leg.dispose(); }
}

// ---- 腿 D2:池容量 fail-closed(超限拒绝 + 精确错误信息) ----

async function poolFailClosedLeg(): Promise<Record<string, unknown>> {
  const leg = await openLeg(64, 64, SCENE_OPTIONS, false);
  try {
    const controller = new MegaLightsFrameController(leg.renderer.session);
    try {
      // 假上下文资源:MAX 闸在决策后、任何 GPU 使用前抛出,纹理不会被消费。
      const device = leg.renderer.session.device;
      const depthTexture = device.createTexture({ label: "mega fail-closed probe depth", size: [64, 64],
        format: "depth32float", usage: GPUTextureUsage.TEXTURE_BINDING });
      const colorTexture = device.createTexture({ label: "mega fail-closed probe color", size: [64, 64],
        format: "rgba16float", usage: GPUTextureUsage.RENDER_ATTACHMENT });
      const points = Array.from({ length: MAX_MEGA_LIGHTS + 1 }, (_, index) => ({
        positionView: [Math.cos(index * 0.01), 0.5, -2 - (index % 7)] as LightVector3,
        range: 0, color: [1, 1, 1] as LightVector3, intensity: 1, decay: 2,
      }));
      let threw: Error | undefined;
      try {
        controller.encodeFrame({ encoder: device.createCommandEncoder({ label: "mega fail-closed probe" }),
          width: 64, height: 64, colorView: colorTexture.createView(), depthTexture,
          depthViewProjection: new Float32Array(16), worldToView: new Float32Array(16),
          lights: { points } });
      } catch (error) { threw = error as Error; }
      depthTexture.destroy();
      colorTexture.destroy();
      return { threw: threw?.message ?? null,
        pass: threw?.message.includes("mega pool capacity") === true,
        gate: "encodeFrame must reject > MAX_MEGA_LIGHTS with capacity message" };
    } finally { controller.dispose(); }
  } finally { leg.dispose(); }
}

// ---- 组装入口(runner 逐腿调用) ----

export function probeAdapterInfo(): unknown {
  return { href: location.href, userAgent: navigator.userAgent, webgpu: "gpu" in navigator };
}

export async function runFullFrameOn(): Promise<Record<string, unknown>> { return fullFrameLeg(true); }
export async function runFullFrameOff(): Promise<Record<string, unknown>> { return fullFrameLeg(false); }
export async function runPixelCorrectness(): Promise<Record<string, unknown>> { return pixelLeg(); }
export async function runBitwiseOff(): Promise<Record<string, unknown>> { return bitwiseLeg(); }
export async function runBudgetDegradation(): Promise<Record<string, unknown>> { return budgetDegradationLeg(); }
export async function runPoolFailClosed(): Promise<Record<string, unknown>> { return poolFailClosedLeg(); }
