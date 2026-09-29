import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { isPbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import { decodeFurnaceColor, furnaceSphereSegmentation, packFurnaceSphere, uniformFurnaceEquirect,
  WHITE_FURNACE_ENVIRONMENT_RADIANCE, WHITE_LAMBERTIAN_MATERIAL } from "../src/webgpu/whiteFurnace.js";
import { atmosphereSkyEnvironmentImage, type AtmosphereSkyParameters,
  type RadianceHdrImageShape } from "../src/environment/atmosphereSky.js";
import { expectedSphereRadiance, HEIGHT, VERTICAL_FOV, WIDTH } from "./atmosphereSkyReference.js";
import type { RenderPacket } from "../src/renderPacket.js";

/**
 * I-C6 物理大气散射天空真机探针(headless Chrome;形态同 whiteFurnaceGpuProbe)。
 * 腿:dawn/noon/dusk = 天空背景三时段对照;furnace-uniform = 白炉基线(≡0.5 自证链路);
 * furnace-dawn/furnace-sky = 白球 + 天空 IBL(CPU 参考 = 纯 Lambert E(n)/π,同一图像
 * 数据源);sky 腿带 staged 竞态自愈(re-stage 环境后重试本帧)。
 */

export type SkyLegKind = "dawn" | "noon" | "dusk" | "neutral" | "furnace-sky" | "furnace-dawn" | "furnace-uniform";

export interface SkyLegResult {
  readonly kind: SkyLegKind;
  readonly frames: number;
  readonly background: { readonly pixels: number; readonly luma: number;
    readonly rgb: readonly [number, number, number]; readonly redBlue: number };
  readonly furnace?: { readonly compared: number; readonly p95Rel: number; readonly maxRel: number;
    readonly meanRel: number; readonly freeEnergyMax: number };
  readonly error?: string;
}

const WARM_FRAMES = 4, MEASURE_FRAMES = 3;
const SUN_TURBIDITY = 4;
const SUN_DIRECTIONS = Object.freeze({
  dawn: sunDirection(15), noon: sunDirection(60), dusk: sunDirection(5),
});

function sunDirection(elevationDeg: number): readonly [number, number, number] {
  const elevation = elevationDeg * Math.PI / 180;
  return Object.freeze([0, Math.cos(elevation), Math.sin(elevation)]);
}

const WHITE_SPHERES = Object.freeze([
  { position: [0, 0, 0] as const, radius: 1.7, material: WHITE_LAMBERTIAN_MATERIAL },
]);


const VIEW = {
  eye: [0, 0, 5] as const, target: [0, 0, 0] as const, extent: 10,
  background: [0.02, 0.02, 0.02] as const, floor: [0.05, 0.05, 0.05] as const, exposure: 1.0,
  roughness: 0.5, verticalFovRadians: VERTICAL_FOV, panoramaBackground: { toneMapped: true },
  width: WIDTH, height: HEIGHT, pixelRatio: 1,
};

/** lights:{directional:[]} = 作者显式关闭方向灯(天空 IBL 不含日盘,直射归灯)。 */
const LIGHTS_OFF = { lights: { directional: [] as never[] } } as const;

const FEATURES = { environment: true, fog: false, groundPlane: false, groundGrid: false,
  ambientOcclusion: false, temporalAa: false, spatialAa: false, occlusionCulling: false,
  bloom: false, vignette: false } as const;

function skyParameters(kind: "dawn" | "noon" | "dusk"): AtmosphereSkyParameters {
  return { turbidity: SUN_TURBIDITY, sunDirectionEnu: SUN_DIRECTIONS[kind] };
}

/** 帧视图:studio 腿(无全景源)不得请求 panoramaBackground(键整个不存在)。 */
type RenderViewLike = Parameters<PbrRenderer["validateFrame"]>[0];
function buildView(kind: SkyLegKind): RenderViewLike {
  const base = {
    eye: VIEW.eye, target: VIEW.target, extent: VIEW.extent, background: VIEW.background,
    floor: VIEW.floor, exposure: VIEW.exposure, roughness: VIEW.roughness,
    verticalFovRadians: VIEW.verticalFovRadians, width: WIDTH, height: HEIGHT, pixelRatio: 1,
    ...LIGHTS_OFF,
  };
  return (kind === "neutral" ? base : { ...base, panoramaBackground: { toneMapped: true } }) as RenderViewLike;
}

interface ActiveLeg {
  readonly kind: SkyLegKind;
  readonly skySource?: { readonly kind: "radiance-hdr"; readonly image: RadianceHdrImageShape };
  readonly canvas: HTMLCanvasElement;
  readonly renderer: PbrRenderer;
  readonly segmentation?: readonly number[];
  readonly expected?: Float32Array;
  readonly samples: { readonly luma: number; readonly r: number; readonly g: number; readonly b: number }[];
  frameCount: number;
}

let active: ActiveLeg | undefined;
const completed: SkyLegResult[] = [];

export async function beginLeg(kind: SkyLegKind): Promise<void> {
  if (active) throw new Error("Previous sky leg was not ended.");
  // GPU 会话竞态自愈:canvas layout 与环境 staging 的时序窗口内首帧 surface 缺失会让
  // 环境状态机回滚默认 studio(约半数会话触发);检测 current.panorama,缺失即整腿
  // 重建,最多重试 2 次。
  for (let attempt = 0; ; attempt += 1) {
    try { active = await startLeg(kind); return; }
    catch (error) {
      if (attempt >= 2) throw error;
      console.log(`[sky-probe] ${kind} leg retry ${attempt + 1}: ${error instanceof Error ? error.message : error}`);
    }
  }
}

async function startLeg(kind: SkyLegKind): Promise<ActiveLeg> {
  const canvas = document.createElement("canvas");
  const sunKind = kind === "furnace-sky" ? "noon" : kind === "furnace-dawn" ? "dawn" : kind;
  const skySource = kind === "neutral" || kind === "furnace-uniform" ? undefined
    : { kind: "radiance-hdr" as const, image: atmosphereSkyEnvironmentImage(
      skyParameters(sunKind as "dawn" | "noon" | "dusk"), 256, 128) };
  canvas.width = WIDTH; canvas.height = HEIGHT;
  canvas.style.width = `${WIDTH}px`; canvas.style.height = `${HEIGHT}px`;
  document.body.appendChild(canvas);
  const source = kind === "furnace-uniform"
    ? { kind: "radiance-hdr" as const, image: uniformFurnaceEquirect(WHITE_FURNACE_ENVIRONMENT_RADIANCE) }
    : skySource ?? { kind: "studio" as const };
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    environment: source,
    features: { ...FEATURES },
    frameCapture: { session: new FrameCaptureSession(),
      readbacks: { requests: [{ resourceId: "present-color" }] } },
  });
  if (kind === "furnace-sky" || kind === "furnace-dawn") {
    renderer.setInstances(packFurnaceSphere([...WHITE_SPHERES]));
  }
  await renderer.validateFrame(buildView(kind));
  // validateFrame 内部也是 render:首帧 surface 缺失会回滚释放 radiance-hdr 环境(回退
  // 默认 studio),后续腿必挂 —— 显式确认首帧已提交,失败交给 runner 重试。
  const warmup = renderer.render(buildView(kind));
  if (warmup === undefined) throw new Error("First sky frame rolled back (surface unavailable).");
  const internals = renderer as unknown as { environment?: { current?: { panorama?: unknown } } };
  if (kind !== "neutral" && internals.environment?.current?.panorama === undefined) {
    renderer.dispose(); canvas.remove();
    throw new Error("Environment rolled back to default studio (staging race); rebuilding leg.");
  }
  return {
    kind, canvas, renderer, ...(skySource ? { skySource } : {}),
    ...(kind === "furnace-sky" || kind === "furnace-dawn" ? {
      segmentation: furnaceSphereSegmentation(WIDTH, HEIGHT, 5, 1.7, VERTICAL_FOV),
    } : {}),
    ...(kind === "furnace-sky" ? {
      expected: expectedSphereRadiance(skyParameters("noon")),
    } : kind === "furnace-dawn" ? {
      expected: expectedSphereRadiance(skyParameters("dawn")),
    } : kind === "furnace-uniform" ? {
      expected: (() => {
        const expected = new Float32Array(WIDTH * HEIGHT * 3);
        for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
          expected[index * 3] = WHITE_FURNACE_ENVIRONMENT_RADIANCE;
          expected[index * 3 + 1] = WHITE_FURNACE_ENVIRONMENT_RADIANCE;
          expected[index * 3 + 2] = WHITE_FURNACE_ENVIRONMENT_RADIANCE;
        }
        return expected;
      })(),
    } : {}),
    samples: [], frameCount: 0,
  };
}

export async function stepLeg(count: number): Promise<readonly number[]> {
  if (!active) throw new Error("beginLeg was not called.");
  const view = buildView(active.kind), frames: number[] = [];
  for (let index = 0; index < count; index += 1) {
    let metrics: ReturnType<typeof active.renderer.render>;
    try {
      metrics = active.renderer.render(view);
    } catch (error) {
      // 竞态兜底:pending 激活与首帧 rollback 竞争时 current 回退默认 studio,prepare
      // 抛 "staged HDR background"。重 stage 天空源并重试本帧(数据面一致)。
      if (!active.skySource || !String(error).includes("staged HDR background")) throw error;
      console.log(`[sky-probe] ${active.kind} re-staging environment after rollback race`);
      await active.renderer.stageEnvironment(active.skySource);
      metrics = active.renderer.render(view);
    }
    active.frameCount += 1;
    frames.push(metrics?.frame ?? active.frameCount);
    const results = await active.renderer.frameReadbackResults;
    const color = (results ?? []).find(result => isPbrFrameReadbackSnapshot(result));
    if (!color) throw new Error("Sky color readback unavailable.");
    if (index < WARM_FRAMES - 1) continue;
    const pixels = decodeFurnaceColor(color);
    let luma = 0, r = 0, g = 0, b = 0;
    for (let pixel = 0; pixel < WIDTH * HEIGHT * 3; pixel += 3) {
      luma += 0.2126 * pixels[pixel]! + 0.7152 * pixels[pixel + 1]! + 0.0722 * pixels[pixel + 2]!;
      r += pixels[pixel]!; g += pixels[pixel + 1]!; b += pixels[pixel + 2]!;
    }
    const total = WIDTH * HEIGHT;
    active.samples.push({ luma: luma / total, r: r / total, g: g / total, b: b / total });
  }
  return frames;
}

/** 白球守恒分析:几何域逐像素 vs CPU 期望(p95/max 相对误差 + 自由能量上界)。 */
function analyseFurnace(pixels: Float32Array, expected: Float32Array,
  segmentation: readonly number[] | undefined): SkyLegResult["furnace"] {
  const relative: number[] = [];
  let compared = 0, freeEnergyMax = 0;
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 1) {
    if (segmentation && segmentation[pixel] !== 0) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      const value = pixels[pixel * 3 + channel]!, want = expected[pixel * 3 + channel]!;
      if (want < 0.005) continue; // 暗区相对误差无意义(f16 量化下限)
      relative.push(Math.abs(value - want) / want);
      freeEnergyMax = Math.max(freeEnergyMax, value - want);
      compared += 1;
    }
  }
  relative.sort((left, right) => left - right);
  const mean = relative.reduce((sum, value) => sum + value, 0) / Math.max(relative.length, 1);
  return {
    compared,
    p95Rel: relative[Math.min(relative.length - 1, Math.floor(0.95 * relative.length))] ?? NaN,
    maxRel: relative[relative.length - 1] ?? NaN,
    meanRel: mean,
    freeEnergyMax,
  };
}

/** 腿级容错清理:dispose renderer + 移除 canvas + 复位 active,不依赖 endLeg 判定。 */
export async function abortLeg(): Promise<void> {
  if (!active) return;
  try { active.renderer.dispose(); } catch { /* 尽力清理 */ }
  active.canvas.remove();
  active = undefined;
}

export async function flushPresent(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}


export async function endLeg(): Promise<SkyLegResult> {
  if (!active) throw new Error("beginLeg was not called.");
  if (active.samples.length === 0) throw new Error("Sky leg measured no frames.");
  const count = active.samples.length;
  const mean = active.samples.reduce((sum, sample) => ({
    luma: sum.luma + sample.luma / count, r: sum.r + sample.r / count,
    g: sum.g + sample.g / count, b: sum.b + sample.b / count,
  }), { luma: 0, r: 0, g: 0, b: 0 });
  let furnace: SkyLegResult["furnace"];
  if (active.kind === "furnace-sky" || active.kind === "furnace-dawn") {
    const results = await active.renderer.frameReadbackResults;
    const color = (results ?? []).find(result => isPbrFrameReadbackSnapshot(result));
    if (!color) throw new Error("Furnace readback unavailable.");
    furnace = active.expected
      ? analyseFurnace(decodeFurnaceColor(color), active.expected, active.segmentation)
      : { compared: 0, p95Rel: NaN, maxRel: NaN, meanRel: NaN, freeEnergyMax: NaN };
  }
  const result: SkyLegResult = Object.freeze({
    kind: active.kind, frames: active.frameCount,
    background: { pixels: WIDTH * HEIGHT, luma: mean.luma,
      rgb: [mean.r, mean.g, mean.b] as const, redBlue: mean.r / Math.max(mean.b, 1e-9) },
    ...(furnace ? { furnace } : {}),
  });
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
