import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import { isPbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import { decodeHalfFloat } from "../src/rayTracing/probeGridBakeMath.js";
import type { FrameMetrics } from "../src/webgpu/pbrRendererTypes.js";
import type { RenderPacket } from "../src/renderPacket.js";

/**
 * C10 屏幕空间接触阴影真机探针(headless Chrome WebGPU,分步驱动形态同 whiteFurnaceGpuProbe)。
 * 双腿(off/on)同一悬浮场景:大地面 + 悬浮板,主光斜照、castShadow=false——
 * 接触阴影是唯一的遮蔽项,对照即净贡献。
 * 证据三路:
 *  1) 像素能量:present-color 读回,中心区(板+接触根部)开/关对照必须变暗,外场必须不变;
 *  2) F1 逐 pass GPU 计时:contact-shadow pass 毫秒 + 全帧毫秒(真机帧时开销);
 *  3) FrameMetrics.contactShadowTier 遥测接线验证。
 */

export interface ContactShadowLegAnalysis {
  readonly on: boolean;
  readonly frames: number;
  readonly centerMeanLuma: number;
  readonly outerMeanLuma: number;
  readonly darkenedCount: number;
  readonly compared: number;
  readonly meanAbsDiff: number;
  readonly brightenedCount: number;
  readonly frameCpuMs: number;
  readonly contactPassMs: number | null;
  readonly totalGpuMs: number | null;
  tier: string | null;
  readonly error?: string;
}

const WIDTH = 320, HEIGHT = 320, WARM_FRAMES = 6, MEASURE_FRAMES = 5;
/** 中心区:板投影+接触根部(光斜照,接触阴影落在板 footprint 附近)。 */
const CENTER = { x0: 0.05, x1: 0.95, y0: 0.55, y1: 0.98 }; // 下半帧地面:接触阴影带+近处地面
const OUTER = { x0: 0.05, x1: 0.95, y0: 0.03, y1: 0.3 }; // 上部背景:完全不受接触影响的区域

function floorAndSlabPacket(): RenderPacket {
  const floor = { x: 6, y: 0.05, z: 6 };
  const slab = { x: 1.1, y: 0.22, z: 1.1 }; // 悬空 0.5:接触阴影带落在板前下方地面,可见 // 底面 0.12:在 balanced 半径(0.35)可达高度内
  const white = [1, 1, 1] as const;
  const quad = (cx: number, cy: number, cz: number, hx: number, hz: number, ny: number): number[] => [
    cx - hx, cy, cz - hz, 0, ny, 0, cx + hx, cy, cz - hz, 0, ny, 0,
    cx + hx, cy, cz + hz, 0, ny, 0, cx - hx, cy, cz + hz, 0, ny, 0,
  ];
  const boxTop = (cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): number[] => {
    const face = (points: number[][], n: number[]): number[] => points.flatMap(point => [...point, ...n]);
    return face([
      [cx - hx, cy + hy, cz - hz], [cx + hx, cy + hy, cz - hz], [cx + hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz + hz],
    ], [0, 1, 0]).concat(face([
      [cx - hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz - hz], [cx - hx, cy - hy, cz - hz],
    ], [0, -1, 0])).concat(face([
      [cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz], [cx + hx, cy + hy, cz - hz], [cx - hx, cy + hy, cz - hz],
    ], [0, 0, -1])).concat(face([
      [cx + hx, cy - hy, cz + hz], [cx - hx, cy - hy, cz + hz], [cx - hx, cy + hy, cz + hz], [cx + hx, cy + hy, cz + hz],
    ], [0, 0, 1]));
  };
  const vertices = new Float32Array([...quad(0, 0, 0, floor.x, floor.z, 1),
    ...boxTop(0, 0.52, 0, slab.x, slab.y, slab.z)]);
  return {
    geometries: [{ id: "contact-scene", revision: 0, vertices,
      indices: new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11, 12, 13, 14, 12, 14, 15]) }],
    materials: [{ id: "white", baseColor: white, metallic: 0, roughness: 1 }],
    instances: [
      { id: "floor", geometry: "contact-scene", material: "white",
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    ],
  };
}

const VIEW = {
  eye: [0, 2.4, 4.6] as const, target: [0, 0.35, 0] as const, extent: 10,
  background: [0.05, 0.05, 0.06] as const, floor: [0, 0, 0] as const, exposure: 1,
  roughness: 0.6, verticalFovRadians: Math.PI / 4, width: WIDTH, height: HEIGHT, pixelRatio: 1,
  lights: { directional: [{ directionWorld: [-0.4, -0.6, 0.6] as const, color: [2.4, 2.3, 2.1] as const, intensity: 1, castShadow: false }] },
};

const FEATURES_BASE = { environment: true, fog: false, groundPlane: false, groundGrid: false,
  ambientOcclusion: false, temporalAa: false, spatialAa: false, occlusionCulling: false,
  bloom: false, vignette: true } as const;

interface ActiveLeg {
  readonly on: boolean;
  offPixels?: Float32Array;
  readonly canvas: HTMLCanvasElement;
  readonly renderer: PbrRenderer;
  readonly frameCpuMs: number[];
  readonly contactPassMs: Array<number | null>;
  readonly totalGpuMs: Array<number | null>;
  tier: string | null;
  lastPixels?: { readonly centerMean: number; readonly outerMean: number;
    darkenedCount?: number; compared?: number; meanAbsDiff?: number; brightenedCount?: number };
  frameCount: number;
}

let active: ActiveLeg | undefined;
let offFrameLuma: Float32Array | undefined;
let offFrameSize = 0;
const completed: ContactShadowLegAnalysis[] = [];

export function probeLegCount(): number { return completed.length; }

export async function beginLeg(on: boolean): Promise<void> {
  if (active) throw new Error("Previous leg was not ended.");
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH; canvas.height = HEIGHT;
  canvas.style.width = `${WIDTH}px`; canvas.style.height = `${HEIGHT}px`;
  document.body.appendChild(canvas);
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    environment: { kind: "studio" },
    features: on ? { ...FEATURES_BASE, contactShadows: true } : FEATURES_BASE,
    ...(on ? { contactShadows: { requestedTier: "balanced" as const } } : {}),
    gpuPassTiming: true,
    frameCapture: { session: new (await import("../src/r12/frameCapture.js")).FrameCaptureSession(),
      readbacks: { requests: [{ resourceId: "present-color" }] } },
  });
  renderer.setPacket(floorAndSlabPacket());
  await renderer.validateFrame(VIEW);
  active = { on, canvas, renderer, frameCpuMs: [], contactPassMs: [], totalGpuMs: [], tier: null, frameCount: 0 };
}

export async function stepLeg(count: number): Promise<readonly number[]> {
  if (!active) throw new Error("beginLeg was not called.");
  const frames: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const metrics: FrameMetrics | undefined = active.renderer.render(VIEW);
    active.frameCount += 1;
    frames.push(metrics?.frame ?? active.frameCount);
    if (metrics) {
      active.frameCpuMs.push(metrics.cpuSubmitMs);
      active.tier = metrics.contactShadowTier ?? active.tier;
      const timings = metrics.gpuPassTimings;
      const pass = timings?.passes?.find(entry => entry.passId === "contact-shadow");
      active.contactPassMs.push(pass ? pass.durationMs : null);
      active.totalGpuMs.push(timings?.milliseconds ?? null);
    }
    const results = await active.renderer.frameReadbackResults;
    const snapshots = (results ?? []).filter(isPbrFrameReadbackSnapshot);
    const color = snapshots.find(result => result.resourceId === "present-color");
    if (color) {
      const words = new Uint16Array(color.bytes.buffer, color.bytes.byteOffset, color.bytes.byteLength / 2);
      const stride = color.bytesPerRow / 2;
      const luma = new Float32Array((color.width / 2) * (color.height / 2));
      let li = 0;
      for (let y = 0; y < color.height; y += 2) {
        for (let x = 0; x < color.width; x += 2) {
          const offset = y * stride + x * 4;
          luma[li++] = 0.2126 * decodeHalfFloat(words[offset]!) + 0.7152 * decodeHalfFloat(words[offset + 1]!)
            + 0.0722 * decodeHalfFloat(words[offset + 2]!);
        }
      }
      if (!active.on) {
        offFrameLuma = luma;
        active.lastPixels = { centerMean: 0, outerMean: 0 };
      } else if (offFrameLuma && offFrameLuma.length === luma.length) {
        let darkened = 0, brightened = 0, absDiff = 0;
        for (let index = 0; index < luma.length; index++) {
          const diff = offFrameLuma[index]! - luma[index]!;
          absDiff += Math.abs(diff);
          if (diff > 0.02 && diff > offFrameLuma[index]! * 0.1) darkened += 1;
          if (-diff > 0.02 && -diff > luma[index]! * 0.1) brightened += 1;
        }
        const means = offFrameLuma.reduce((a, b) => a + b, 0) / luma.length;
        const meanOn = luma.reduce((a, b) => a + b, 0) / luma.length;
        active.lastPixels = { centerMean: meanOn, outerMean: means,
          darkenedCount: darkened, compared: luma.length, meanAbsDiff: absDiff / luma.length, brightenedCount: brightened };
      }
    }
  }
  return frames;
}

/** 合成器呈现后返回;截图前必须先走到这里(双 rAF)。 */
export async function flushPresent(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

export async function endLeg(): Promise<ContactShadowLegAnalysis> {
  if (!active) throw new Error("beginLeg was not called.");
  if (!active.lastPixels) throw new Error("Leg captured no pixels.");
  const mean = (values: Array<number | null>): number | null => {
    const usable = values.filter((value): value is number => value !== null);
    return usable.length ? usable.reduce((total, value) => total + value, 0) / usable.length : null;
  };
  const analysis: ContactShadowLegAnalysis = Object.freeze({
    on: active.on, frames: active.frameCount,
    centerMeanLuma: active.lastPixels.centerMean, outerMeanLuma: active.lastPixels.outerMean,
    darkenedCount: active.lastPixels.darkenedCount ?? 0, compared: active.lastPixels.compared ?? 0,
    meanAbsDiff: active.lastPixels.meanAbsDiff ?? 0, brightenedCount: active.lastPixels.brightenedCount ?? 0,
    frameCpuMs: mean(active.frameCpuMs) ?? 0,
    contactPassMs: mean(active.contactPassMs), totalGpuMs: mean(active.totalGpuMs),
    tier: active.tier,
  });
  active.renderer.dispose();
  active.canvas.remove();
  active = undefined;
  completed.push(analysis);
  return analysis;
}

export async function probeAdapterInfo(): Promise<{ readonly vendor?: string; readonly architecture?: string;
  readonly description?: string }> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter.");
  const info = adapter.info ?? {};
  return { vendor: info.vendor, architecture: info.architecture, description: info.description };
}

export const CONTACT_PROBE_CONSTANTS = Object.freeze({ WIDTH, HEIGHT, WARM_FRAMES, MEASURE_FRAMES, CENTER });
