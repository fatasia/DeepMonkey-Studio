/// <reference types="@webgpu/types" />
import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import { isPbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import { decodeHalfFloat } from "../src/rayTracing/probeGridBakeMath.js";
import { buildReferenceRoomScene } from "../src/lighting/probeReferenceScene.js";
import type { RenderPacket } from "../src/renderPacket.js";

/**
 * Brief-GI M3 消费接线像素探针(真机;scripts/sdf-gi-m3-gpu.mjs 驱动,形态照抄
 * lab/contactShadowGpuProbe):参考房间(薄墙+门洞)双腿 features.sdfGi off/on,
 * 各渲昼(environmentIntensity=1)/夜(0.15)两视图,present-color 读回对比。
 * 验收门:开启后像素可见变化(门内暗化 = 探针遮蔽生效)+ 昼夜随 intensity 缩放。
 */

export interface SdfGiM3PixelLeg {
  readonly sdfGi: boolean;
  readonly frames: number;
  readonly indoorMeanLuma: number;
  readonly outdoorMeanLuma: number;
  readonly error?: string;
}

export interface SdfGiM3PixelDiff {
  readonly compared: number;
  readonly changedCount: number;
  readonly darkenedIndoorCount: number;
  readonly brightenedIndoorCount: number;
  readonly meanAbsDiff: number;
  /** 变化像素的空间质心(全帧归一坐标;诊断变化区是否落在门洞方向)。 */
  readonly changedCentroidX: number;
  readonly changedCentroidY: number;
  readonly indoorMeanOff: number;
  readonly indoorMeanOn: number;
  /** 8×8 块均值差值网格(off→on 的 |Δluma|;空间模式诊断)。 */
  readonly blockDiffGrid: readonly number[];
  /** 中心行横向亮度采样(64 点,off/on;诊断消费生效范围)。 */
  readonly centerRowOff: readonly number[];
  readonly centerRowOn: readonly number[];
  readonly dayNightIndoorRatioOn: number;
  readonly dayNightIndoorRatioOff: number;
  readonly errors: readonly string[];
}

const WIDTH = 320, HEIGHT = 240, SETTLE_FRAMES = 6;
/** 相机:贴近视轴,门洞占画面大块;直射降权(0.25)让 GI ambient 项差异可辨。 */
const VIEW = {
  eye: [1.4, 1.7, 3.0] as const, target: [5.2, 1.1, 3.0] as const, extent: 7,
  background: [0.03, 0.03, 0.04] as const, floor: [0, 0, 0] as const, exposure: 1,
  roughness: 0.6, verticalFovRadians: Math.PI / 4, width: WIDTH, height: HEIGHT, pixelRatio: 1,
  lights: { directional: [{ directionWorld: [0.25, -1, -0.12] as const,
    color: [2.2, 2.1, 1.9] as const, intensity: 0.25, castShadow: false }] },
};
const DAY_VIEW = { ...VIEW, environmentIntensity: 1 } as const;
const NIGHT_VIEW = { ...VIEW, environmentIntensity: 0.15 } as const;
// 屏幕分区:门洞竖带(画面中心,视线穿门洞命中门内;真机行采样定位的变化区)与
// 全帧对照。门内命中点 = 探针遮蔽生效区,开启后应显著暗化。
const INDOOR = { x0: 0.4, x1: 0.6, y0: 0.25, y1: 0.8 };

/** 参考房间 → RenderPacket(12 盒 × 12 三角形,恒等变换,白墙材质)。 */
export function referenceRoomPacket(): RenderPacket {
  const boxes = buildReferenceRoomScene().boxes;
  const vertices: number[] = [];
  const indices: number[] = [];
  boxes.forEach((box, boxIndex) => {
    const [x0, y0, z0] = box.min, [x1, y1, z1] = box.max;
    const base = vertices.length / 6;
    vertices.push(
      x0, y0, z0, 0, 0, 1, x1, y0, z0, 0, 0, 1, x1, y1, z0, 0, 0, 1, x0, y1, z0, 0, 0, 1,
      x0, y0, z1, 0, 0, 1, x1, y0, z1, 0, 0, 1, x1, y1, z1, 0, 0, 1, x0, y1, z1, 0, 0, 1,
    );
    indices.push(...[0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
      3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5].map(index => base + index));
    void boxIndex;
  });
  return {
    geometries: [{ id: "ref-room", revision: 0, vertices: new Float32Array(vertices),
      indices: new Uint32Array(indices) }],
    materials: [{ id: "wall", baseColor: [0.75, 0.74, 0.72], metallic: 0, roughness: 0.9 }],
    instances: boxes.map((box, index) => ({ id: `box-${index}`, geometry: "ref-room",
      material: "wall", transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] })),
  };
}

const FEATURES_BASE = { environment: true, fog: false, groundPlane: false, groundGrid: false,
  ambientOcclusion: false, temporalAa: false, spatialAa: false, occlusionCulling: false,
  bloom: false, vignette: false } as const;

interface LegState {
  readonly sdfGi: boolean;
  readonly renderer: PbrRenderer;
  frames: number;
}

const completed: SdfGiM3PixelLeg[] = [];
const framesByLeg: Map<boolean, Map<string, Float32Array>> = new Map([
  [false, new Map()], [true, new Map()],
]);

export function pixelLegCount(): number { return completed.length; }

export async function beginPixelLeg(sdfGi: boolean): Promise<void> {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH; canvas.height = HEIGHT;
  document.body.appendChild(canvas);
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    environment: { kind: "studio" },
    features: sdfGi ? { ...FEATURES_BASE, sdfGi: true } : FEATURES_BASE,
    ...(sdfGi ? { sdfGi: { cellSize: 0.15, instanceDomain: "scene" as const } } : {}),
    frameCapture: { session: new (await import("../src/r12/frameCapture.js")).FrameCaptureSession(),
      readbacks: { requests: [{ resourceId: "present-color" }] } },
  });
  renderer.setPacket(referenceRoomPacket());
  await renderer.validateFrame(DAY_VIEW);
  framesByLeg.get(sdfGi)!.clear();
  legs.push({ sdfGi, renderer, frames: 0 });
}

const legs: LegState[] = [];

function regionLuma(words: Uint16Array, stride: number, width: number, height: number,
  region: { x0: number; x1: number; y0: number; y1: number }): number {
  let sum = 0, count = 0;
  for (let y = Math.floor(height * region.y0); y < Math.floor(height * region.y1); y += 2) {
    for (let x = Math.floor(width * region.x0); x < Math.floor(width * region.x1); x += 2) {
      const offset = y * stride + x * 4;
      sum += 0.2126 * decodeHalfFloat(words[offset]!) + 0.7152 * decodeHalfFloat(words[offset + 1]!)
        + 0.0722 * decodeHalfFloat(words[offset + 2]!);
      count += 1;
    }
  }
  return count ? sum / count : 0;
}

function regionPixels(words: Uint16Array, stride: number, width: number, height: number,
  region: { x0: number; x1: number; y0: number; y1: number }):
  { values: Float32Array; width: number; height: number } {
  const x0 = Math.floor(width * region.x0), x1 = Math.floor(width * region.x1);
  const y0 = Math.floor(height * region.y0), y1 = Math.floor(height * region.y1);
  const values = new Float32Array((x1 - x0) * (y1 - y0));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const offset = y * stride + x * 4;
      values[(y - y0) * (x1 - x0) + (x - x0)] =
        0.2126 * decodeHalfFloat(words[offset]!) + 0.7152 * decodeHalfFloat(words[offset + 1]!)
          + 0.0722 * decodeHalfFloat(words[offset + 2]!);
    }
  }
  return { values, width: x1 - x0, height: y1 - y0 };
}

/** 渲染 step 帧并按视图缓存 present-color luma(昼/夜各采一次)。 */
export async function stepPixelLeg(count: number): Promise<readonly number[]> {
  const leg = legs[legs.length - 1]!;
  const frames: number[] = [];
  for (let index = 0; index < count; index++) {
    const view = leg.frames % 2 === 0 ? DAY_VIEW : NIGHT_VIEW;
    const metrics = leg.renderer.render(view);
    leg.frames += 1;
    frames.push(metrics?.frame ?? leg.frames);
    const results = await leg.renderer.frameReadbackResults;
    const snapshot = (results ?? []).filter(isPbrFrameReadbackSnapshot)
      .find(result => result.resourceId === "present-color");
    if (snapshot && leg.frames > SETTLE_FRAMES) {
      const words = new Uint16Array(snapshot.bytes.buffer, snapshot.bytes.byteOffset,
        snapshot.bytes.byteLength / 2);
      const stride = snapshot.bytesPerRow / 2;
      const cache = framesByLeg.get(leg.sdfGi)!;
      const phase = leg.frames % 2 === 0 ? "day" : "night";
      cache.set(phase, regionPixels(words, stride, WIDTH, HEIGHT, INDOOR).values);
      const full = regionPixels(words, stride, WIDTH, HEIGHT, { x0: 0.02, x1: 0.98, y0: 0.02, y1: 0.98 });
      cache.set(`${phase}Full`, full.values);
      cache.set(`${phase}Shape`, Float32Array.from([full.width, full.height]));
      // 中心行横向亮度采样(64 点;定位消费生效的空间范围)。
      if (phase === "day") {
        const row = Math.floor(HEIGHT * 0.5);
        const samples = new Float32Array(64);
        for (let sample = 0; sample < 64; sample++) {
          const x = Math.floor(WIDTH * (sample + 0.5) / 64);
          const offset = row * stride + x * 4;
          samples[sample] = 0.2126 * decodeHalfFloat(words[offset]!)
            + 0.7152 * decodeHalfFloat(words[offset + 1]!)
            + 0.0722 * decodeHalfFloat(words[offset + 2]!);
        }
        cache.set("centerRow", samples);
      }
    }
  }
  return frames;
}

function mean(values: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < values.length; index++) sum += values[index]!;
  return values.length ? sum / values.length : 0;
}

export async function endPixelLeg(): Promise<SdfGiM3PixelLeg> {
  const leg = legs.pop()!;
  const cache = framesByLeg.get(leg.sdfGi)!;
  const leg_ = {
    sdfGi: leg.sdfGi, frames: leg.frames,
    indoorMeanLuma: mean(cache.get("day") ?? new Float32Array()),
    outdoorMeanLuma: 0,
  };
  leg.renderer.dispose();
  completed.push(leg_);
  return leg_;
}

/** 双腿完成后计算像素验收(开/关 diff + 昼夜比 + 变化空间质心诊断)。 */
export function computePixelDiff(): SdfGiM3PixelDiff {
  const off = framesByLeg.get(false)!, on = framesByLeg.get(true)!;
  const shape = off.get("dayShape") ?? new Float32Array([1, 1]);
  const cols = shape[0]!, rows = shape[1]!;
  const offDay = off.get("dayFull") ?? new Float32Array();
  const onDay = on.get("dayFull") ?? new Float32Array();
  let changed = 0, absSum = 0, sumX = 0, sumY = 0;
  const compared = Math.min(offDay.length, onDay.length);
  for (let index = 0; index < compared; index++) {
    const diff = Math.abs(onDay[index]! - offDay[index]!);
    absSum += diff;
    if (diff > 0.01) {
      changed += 1;
      sumX += index % cols; sumY += Math.floor(index / cols);
    }
  }
  const offIndoorDay = off.get("day") ?? new Float32Array();
  const onIndoorDay = on.get("day") ?? new Float32Array();
  let darkened = 0, brightened = 0;
  for (let index = 0; index < Math.min(offIndoorDay.length, onIndoorDay.length); index++) {
    const diff = offIndoorDay[index]! - onIndoorDay[index]!;
    if (diff > 0.02 && diff > offIndoorDay[index]! * 0.08) darkened += 1;
    if (-diff > 0.02 && -diff > onIndoorDay[index]! * 0.08) brightened += 1;
  }
  const ratioOn = mean(on.get("night") ?? new Float32Array())
    / Math.max(mean(on.get("day") ?? new Float32Array()), 1e-4);
  const ratioOff = mean(off.get("night") ?? new Float32Array())
    / Math.max(mean(off.get("day") ?? new Float32Array()), 1e-4);
  const blockDiffGrid: number[] = [];
  if (offDay.length && offDay.length === onDay.length && cols > 8 && rows > 8) {
    const blockW = Math.floor(cols / 8), blockH = Math.floor(rows / 8);
    for (let by = 0; by < 8; by++) for (let bx = 0; bx < 8; bx++) {
      let sum = 0, count = 0;
      for (let y = by * blockH; y < (by + 1) * blockH; y++) {
        for (let x = bx * blockW; x < (bx + 1) * blockW; x++) {
          const index = y * cols + x;
          if (index < offDay.length) { sum += Math.abs(onDay[index]! - offDay[index]!); count += 1; }
        }
      }
      blockDiffGrid.push(count ? sum / count : 0);
    }
  }
  return { compared, changedCount: changed, darkenedIndoorCount: darkened,
    brightenedIndoorCount: brightened, meanAbsDiff: absSum / Math.max(compared, 1),
    changedCentroidX: compared ? (sumX / Math.max(changed, 1)) / cols : 0,
    changedCentroidY: compared ? (sumY / Math.max(changed, 1)) / rows : 0,
    indoorMeanOff: mean(offIndoorDay), indoorMeanOn: mean(onIndoorDay),
    blockDiffGrid,
    dayNightIndoorRatioOn: ratioOn, dayNightIndoorRatioOff: ratioOff,
    centerRowOff: Array.from(off.get("centerRow") ?? new Float32Array()),
    centerRowOn: Array.from(on.get("centerRow") ?? new Float32Array()),
    errors: [] };
}

/** 合成器呈现后返回;截图前必须先走到这里(双 rAF)。 */
export async function flushPresent(): Promise<void> {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

export async function probeAdapterInfo(): Promise<{ readonly vendor?: string;
  readonly architecture?: string; readonly description?: string }> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter.");
  const info = adapter.info ?? {};
  return { vendor: info.vendor, architecture: info.architecture, description: info.description };
}
