import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { isPbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import { analyzeFurnaceFrame, decodeFurnaceColor, evaluateFurnaceChecks, evaluateSsrToggleChecks,
  furnaceSphereSegmentation, uniformFurnaceEquirect, WHITE_FURNACE_ENVIRONMENT_RADIANCE,
  packFurnaceSphere, WHITE_LAMBERTIAN_MATERIAL,
  type FurnaceAnalysis, type FurnaceCheck, type FurnaceSegmentation } from "../src/webgpu/whiteFurnace.js";
import type { RenderPacket } from "../src/renderPacket.js";

/**
 * C12 白炉真机探针(headless Chrome WebGPU,分步驱动形态同 autoExposureGpuProbe)。
 * 四腿全部走完整 PbrRenderer 管线(全景环境 → 不透明 → 后处理 → present 前 HDR 读回):
 *  - background:无实例,全屏背景直采样,断言全帧 ≡ E(采样/显示链守恒);
 *  - geometry:白 Lambert 粗糙球居中(解析轮廓分割),断言几何域 ≡ E(IBL 能量链守恒);
 *  - ssr-box-off/on:闭合白盒内部 + 白 Lambert 全材质,SSR 关/开同机对照,
 *    断言两态均 ≡ E 且逐像素净差 p99 受控(C11 捆绑验收的守恒回归)。
 * 分析(whiteFurnace.ts 纯 CPU 参考)在页内执行,只回传统计与判定。
 */

export type FurnaceLegKind = "background" | "geometry" | "ssr-box-off" | "ssr-box-on";

export interface FurnaceLegResult {
  readonly kind: FurnaceLegKind;
  readonly frames: number;
  readonly analysis: FurnaceAnalysis;
  readonly checks: readonly FurnaceCheck[];
  readonly error?: string;
}

const WIDTH = 192, HEIGHT = 192, WARM_FRAMES = 4, MEASURE_FRAMES = 3;
const VERTICAL_FOV = Math.PI / 4;

interface ActiveLeg {
  readonly kind: FurnaceLegKind;
  readonly canvas: HTMLCanvasElement;
  readonly renderer: PbrRenderer;
  readonly segmentation: FurnaceSegmentation;
  readonly singleRegion: "background" | "geometry";
  readonly analyses: FurnaceAnalysis[];
  firstFrame?: { readonly pixels: Float32Array; readonly segmentation: FurnaceSegmentation } | undefined;
  frameCount: number;
  measuring: boolean;
}

let active: ActiveLeg | undefined;
const completed: FurnaceLegResult[] = [];

/** 白 Lambert 粗糙球腿;球占满中央,背景/几何双域都可分割。 */
const GEOMETRY_SPHERES = Object.freeze([
  { position: [0, 0, 0] as const, radius: 1.7, material: WHITE_LAMBERTIAN_MATERIAL },
]);

/** 闭合白盒(六面内朝向四边形);SSR 腿场景——任意反射必命中白面。 */
function furnaceBoxPacket(): RenderPacket {
  const S = 4, faces: ReadonlyArray<{ readonly c: readonly number[]; readonly n: readonly number[];
    readonly u: readonly number[]; readonly v: readonly number[] }> = [
    { c: [0, 0, -S], n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { c: [0, 0, S], n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
    { c: [-S, 0, 0], n: [1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { c: [S, 0, 0], n: [-1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { c: [0, -S, 0], n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { c: [0, S, 0], n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  ];
  const vertices: number[] = [], indices: number[] = [];
  faces.forEach((face, index) => {
    const base = index * 4;
    for (const su of [-1, 1]) for (const sv of [-1, 1]) {
      vertices.push(face.c[0]! + su * S * face.u[0]! + sv * S * face.v[0]!,
        face.c[1]! + su * S * face.u[1]! + sv * S * face.v[1]!,
        face.c[2]! + su * S * face.u[2]! + sv * S * face.v[2]!, face.n[0]!, face.n[1]!, face.n[2]!);
    }
    indices.push(base, base + 1, base + 3, base, base + 3, base + 2);
  });
  return {
    geometries: [{ id: "furnace-box", revision: 0,
      vertices: new Float32Array(vertices), indices: new Uint32Array(indices) }],
    materials: [{ id: "white", baseColor: [1, 1, 1] as const, metallic: 0, roughness: 1 }],
    instances: [{ id: "box", geometry: "furnace-box", material: "white",
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
  };
}

const BOX_VIEW = {
  eye: [0, 0, 0] as const, target: [0, 0, -1] as const, extent: 10,
  background: [0.02, 0.02, 0.02] as const, floor: [0.05, 0.05, 0.05] as const, exposure: 1.05,
  roughness: 0.5, verticalFovRadians: VERTICAL_FOV, panoramaBackground: { toneMapped: true },
  width: WIDTH, height: HEIGHT, pixelRatio: 1,
};

const OPEN_VIEW = { ...BOX_VIEW, eye: [0, 0, 5] as const, target: [0, 0, 0] as const };

/** lights:{directional:[]} = 作者显式关闭方向灯(pbrSceneLighting:空数组→intensity 0+无聚类)。 */
const LIGHTS_OFF = { lights: { directional: [] as never[] } } as const;

const BASE_FEATURES = { environment: true, fog: false, groundPlane: false, groundGrid: false,
  ambientOcclusion: false, temporalAa: false, spatialAa: false, occlusionCulling: false,
  bloom: false, vignette: true } as const;

export function probeLegCount(): number { return completed.length; }

export async function beginLeg(kind: FurnaceLegKind): Promise<void> {
  if (active) throw new Error("Previous furnace leg was not ended.");
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH; canvas.height = HEIGHT;
  canvas.style.width = `${WIDTH}px`; canvas.style.height = `${HEIGHT}px`;
  document.body.appendChild(canvas);
  const ssrLeg = kind === "ssr-box-off" || kind === "ssr-box-on";
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    environment: { kind: "radiance-hdr", image: uniformFurnaceEquirect(WHITE_FURNACE_ENVIRONMENT_RADIANCE) },
    features: { ...BASE_FEATURES, ...(ssrLeg ? { screenSpaceReflection: true } : {}) },
    frameCapture: { session: new FrameCaptureSession(),
      readbacks: { requests: [{ resourceId: "present-color" }] } },
  });
  if (kind === "geometry") renderer.setInstances(packFurnaceSphere([...GEOMETRY_SPHERES]));
  if (ssrLeg) renderer.setPacket(furnaceBoxPacket());
  const view = { ...(ssrLeg ? BOX_VIEW : OPEN_VIEW), ...LIGHTS_OFF,
    ...(ssrLeg ? { postProcess: { screenSpaceReflection: kind === "ssr-box-on" } } : {}) };
  await renderer.validateFrame(view);
  active = { kind, canvas, renderer, analyses: [], frameCount: 0, measuring: false,
    segmentation: kind === "geometry"
      ? furnaceSphereSegmentation(WIDTH, HEIGHT, 5, 1.7, VERTICAL_FOV)
      : undefined,
    singleRegion: kind === "background" ? "background" : "geometry" };
}

/** 暖机后调用:之后的 stepLeg 帧才进统计与首测帧导出,暖帧不污染守恒数字。 */
export async function armMeasurement(): Promise<void> {
  if (!active) throw new Error("beginLeg was not called.");
  active.analyses.length = 0;
  active.firstFrame = undefined;
  active.measuring = true;
}

export async function stepLeg(count: number): Promise<readonly number[]> {
  if (!active) throw new Error("beginLeg was not called.");
  const ssrLeg = active.kind === "ssr-box-off" || active.kind === "ssr-box-on";
  const view = { ...(ssrLeg ? BOX_VIEW : OPEN_VIEW), ...LIGHTS_OFF,
    ...(ssrLeg ? { postProcess: { screenSpaceReflection: active.kind === "ssr-box-on" } } : {}) };
  const frames: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const metrics = active.renderer.render(view);
    active.frameCount += 1;
    frames.push(metrics?.frame ?? active.frameCount);
    const results = await active.renderer.frameReadbackResults;
    if (!active.measuring) continue;
    const color = (results ?? []).find(result => isPbrFrameReadbackSnapshot(result));
    if (!color) {
      const reasons = (results ?? []).map(result => "reason" in result ? `${result.resourceId}:${result.reason}` : `${result.resourceId}:ok`);
      throw new Error(`Furnace color readback unavailable this frame (${reasons.join("; ") || "no results"}).`);
    }
    const pixels = decodeFurnaceColor(color);
    const analysis = analyzeFurnaceFrame(pixels, WHITE_FURNACE_ENVIRONMENT_RADIANCE,
      active.segmentation, active.singleRegion);
    active.analyses.push(analysis);
    active.firstFrame ??= { pixels, segmentation: active.segmentation };
  }
  return frames;
}

/** 导出首测帧像素(SSR 开/关净差对拍需要同几何的两份完整像素;数组跨页序列化)。 */
export async function exportFirstFrame(): Promise<{ readonly pixels: number[];
  readonly segmentation: FurnaceSegmentation }> {
  if (!active) throw new Error("beginLeg was not called.");
  if (!active.firstFrame) throw new Error("No measured frame to export.");
  return { pixels: Array.from(active.firstFrame.pixels), segmentation: active.firstFrame.segmentation };
}

/** C11 捆绑判定:同机同场景 SSR 开/关逐像素净差(页内对拍,跨腿导出像素)。 */
export async function compareSsrToggle(off: { readonly pixels: readonly number[];
  readonly segmentation: FurnaceSegmentation },
  on: { readonly pixels: readonly number[]; readonly segmentation: FurnaceSegmentation }):
  Promise<readonly FurnaceCheck[]> {
  const onSegmentation = on.segmentation;
  if (off.segmentation && onSegmentation
    && (off.segmentation.length !== onSegmentation.length
      || off.segmentation.some((value, index) => value !== onSegmentation[index]))) {
    throw new Error("SSR on/off segmentation diverges; toggle comparison would be meaningless.");
  }
  return evaluateSsrToggleChecks(Float32Array.from(on.pixels), Float32Array.from(off.pixels),
    WHITE_FURNACE_ENVIRONMENT_RADIANCE, off.segmentation ?? onSegmentation);
}

export async function endLeg(): Promise<FurnaceLegResult> {
  if (!active) throw new Error("beginLeg was not called.");
  if (active.analyses.length === 0) throw new Error("Furnace leg measured no frames.");
  const worst = active.analyses.reduce((candidate, frame) =>
    Math.abs(frame.global.meanRelativeError) > Math.abs(candidate.global.meanRelativeError) ? frame : candidate);
  const result: FurnaceLegResult = Object.freeze({ kind: active.kind, frames: active.frameCount,
    analysis: worst, checks: evaluateFurnaceChecks(worst) });
  active.renderer.dispose();
  active.canvas.remove();
  active = undefined;
  completed.push(result);
  return result;
}

export async function probeAdapterInfo(): Promise<{ readonly vendor?: string; readonly architecture?: string;
  readonly description?: string }> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter.");
  const info = adapter.info ?? {};
  return { vendor: info.vendor, architecture: info.architecture, description: info.description };
}

export const FURNACE_PROBE_CONSTANTS = Object.freeze({ WIDTH, HEIGHT, WARM_FRAMES, MEASURE_FRAMES });
