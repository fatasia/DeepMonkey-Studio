import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { isPbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import { decodeHalfFloat } from "../src/rayTracing/probeGridBakeMath.js";
import type { FrameMetrics } from "../src/webgpu/pbrRendererTypes.js";
import type { RadianceHdrImage } from "../src/textures/radianceHdr.js";

/**
 * F8 自动曝光真机对拍探针(headless Chrome WebGPU),分步驱动形态:Node 逐腿
 * beginLeg → stepLeg ×N → flushPresent → 元素截图 → decodeDisplayShot → endLeg。
 * 证据两路:
 *  - 逐帧 HDR 场景亮度:capture 白名单 "present-color"(display 变换前的 HDR 缓冲);
 *  - 稳态显示亮度:playwright 元素截图 = 合成器最终呈现像素(真实经过曝光
 *    uniform + ACES WGSL + linear→sRGB),页内 createImageBitmap 解码统计。
 * 环境从亮(L=0.5)切到暗(L=0.01):眼适应语义 = 自动档切换后显示亮度回稳、
 * 亮暗摆幅远小于固定档,且方向正确(亮环境压暗、暗环境提亮)。
 */

export interface AutoExposureProbeFrame {
  readonly frame: number;
  readonly meanSceneLuma: number;
  readonly autoExposure: FrameMetrics["autoExposure"] | null;
}

export interface DisplayCapture {
  readonly environment: "bright" | "dim";
  readonly meanDisplayLuma: number;
  readonly lumaP10: number;
  readonly lumaP90: number;
}

export interface AutoExposureLegResult {
  readonly mode: "fixed" | "auto";
  readonly frames: readonly AutoExposureProbeFrame[];
  readonly display: readonly DisplayCapture[];
  readonly error?: string;
}

const WIDTH = 256, HEIGHT = 256, BOOT_FRAMES = 24, ADAPT_FRAMES = 48;

interface ActiveLeg {
  readonly mode: "fixed" | "auto";
  readonly canvas: HTMLCanvasElement;
  readonly renderer: PbrRenderer;
  readonly frames: AutoExposureProbeFrame[];
  readonly display: DisplayCapture[];
  frameCount: number;
}

let active: ActiveLeg | undefined;
const completed: AutoExposureLegResult[] = [];

/** 等距柱状恒定灰度 HDR(64×32):估计器输入与渲染背景同源,亮度 = 灰度。 */
function uniformEquirect(gray: number): RadianceHdrImage {
  const width = 64, height = 32, data = new Float32Array(width * height * 3);
  for (let index = 0; index < width * height; index++) {
    data[index * 3] = gray; data[index * 3 + 1] = gray; data[index * 3 + 2] = gray;
  }
  return { width, height, data };
}

/** HDR 读回(present-color = display 变换前的场景色)平均亮度,行距与格式感知。 */
function meanSceneLuma(snapshot: { readonly width: number; readonly height: number;
  readonly bytesPerRow: number; readonly format: string; readonly bytes: Uint8Array }): number {
  let sum = 0;
  if (snapshot.format === "rgba16float") {
    const words = new Uint16Array(snapshot.bytes.buffer, snapshot.bytes.byteOffset,
      snapshot.bytes.byteLength / 2);
    const stride = snapshot.bytesPerRow / 2;
    for (let y = 0; y < snapshot.height; y++) {
      for (let x = 0; x < snapshot.width; x++) {
        const offset = y * stride + x * 4;
        sum += 0.2126 * decodeHalfFloat(words[offset]!) + 0.7152 * decodeHalfFloat(words[offset + 1]!)
          + 0.0722 * decodeHalfFloat(words[offset + 2]!);
      }
    }
    return sum / (snapshot.width * snapshot.height);
  }
  for (let y = 0; y < snapshot.height; y++) {
    const row = y * snapshot.bytesPerRow;
    for (let x = 0; x < snapshot.width; x++) {
      const offset = row + x * 4;
      sum += 0.2126 * snapshot.bytes[offset + 2]! + 0.7152 * snapshot.bytes[offset + 1]!
        + 0.0722 * snapshot.bytes[offset]!;
    }
  }
  return sum / (255 * snapshot.width * snapshot.height);
}

const view = {
  eye: [0, 0, 5] as const, target: [0, 0, 0] as const, extent: 10,
  background: [0.02, 0.02, 0.02] as const, floor: [0.05, 0.05, 0.05] as const,
  exposure: 1.05, roughness: 0.5,
  panoramaBackground: { toneMapped: true },
  width: WIDTH, height: HEIGHT, pixelRatio: 1,
};

const FEATURES = { environment: true, fog: false, groundPlane: false, groundGrid: false,
  ambientOcclusion: false, temporalAa: false, spatialAa: false, occlusionCulling: false,
  bloom: false, vignette: true } as const;

export function probeLegCount(): number { return completed.length; }

/** 单个中性球面:背景以全景环境为主,场景非空、直显快路径被 vignette 关闭。 */
export async function beginLeg(mode: "fixed" | "auto", luminances: readonly number[]): Promise<void> {
  if (active) throw new Error("Previous probe leg was not ended.");
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH; canvas.height = HEIGHT;
  canvas.style.width = `${WIDTH}px`; canvas.style.height = `${HEIGHT}px`;
  document.body.appendChild(canvas);
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, new AbortController().signal, {
    environment: { kind: "radiance-hdr", image: uniformEquirect(luminances[0]!) },
    ...(mode === "auto" ? { autoExposure: {} } : {}),
    features: FEATURES,
    frameCapture: { session: new FrameCaptureSession(),
      readbacks: { requests: [{ resourceId: "present-color" }] } },
  });
  renderer.setInstances(new Float32Array([0, 0, 0, 0.6, 0.18, 0.18, 0.18, 0, 0.5, 0, 0, 0]));
  await renderer.validateFrame(view);
  active = { mode, canvas, renderer, frames: [], display: [], frameCount: 0 };
}

export async function stepLeg(count: number): Promise<readonly AutoExposureProbeFrame[]> {
  if (!active) throw new Error("beginLeg was not called.");
  const step: AutoExposureProbeFrame[] = [];
  for (let index = 0; index < count; index++) {
    const metrics = active.renderer.render(view);
    active.frameCount += 1;
    const results = await active.renderer.frameReadbackResults;
    const snapshot = (results ?? []).find(isPbrFrameReadbackSnapshot);
    const record: AutoExposureProbeFrame = Object.freeze({ frame: metrics?.frame ?? active.frameCount,
      meanSceneLuma: snapshot ? meanSceneLuma(snapshot) : Number.NaN,
      autoExposure: metrics?.autoExposure ?? null });
    active.frames.push(record);
    step.push(record);
  }
  return step;
}

/** 环境切换(亮→暗):stageEnvironment 同时喂自动曝光亮度观察器。 */
export async function stageLegEnvironment(luminance: number): Promise<void> {
  if (!active) throw new Error("beginLeg was not called.");
  await active.renderer.stageEnvironment({ kind: "radiance-hdr", image: uniformEquirect(luminance) });
}

/** 让合成器真正呈现后返回;截图前必须先走到这里。 */
export async function flushPresent(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

/** 合成器截图(png dataURL)→ 页内解码 → 显示亮度统计。 */
export async function decodeDisplayShot(pngBase64: string, environment: "bright" | "dim"): Promise<DisplayCapture> {
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error("Screenshot decode failed."));
    image.src = `data:image/png;base64,${pngBase64}`;
  });
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context2d = canvas.getContext("2d");
  if (!context2d) throw new Error("Offscreen 2D context unavailable for screenshot decode.");
  context2d.drawImage(image, 0, 0);
  const { data } = context2d.getImageData(0, 0, canvas.width, canvas.height);
  const lumas: number[] = [];
  for (let offset = 0; offset < data.length; offset += 4) {
    lumas.push((0.2126 * data[offset]! + 0.7152 * data[offset + 1]! + 0.0722 * data[offset + 2]!) / 255);
  }
  lumas.sort((left, right) => left - right);
  const mean = lumas.reduce((total, value) => total + value, 0) / lumas.length;
  const percentile = (fraction: number): number =>
    lumas[Math.min(lumas.length - 1, Math.floor(fraction * lumas.length))]!;
  const capture: DisplayCapture = Object.freeze({ environment, meanDisplayLuma: mean,
    lumaP10: percentile(0.1), lumaP90: percentile(0.9) });
  active?.display.push(capture);
  return capture;
}

export async function endLeg(): Promise<AutoExposureLegResult> {
  if (!active) throw new Error("beginLeg was not called.");
  const leg: AutoExposureLegResult = Object.freeze({ mode: active.mode,
    frames: Object.freeze(active.frames), display: Object.freeze(active.display) });
  active.renderer.dispose();
  active.canvas.remove();
  active = undefined;
  completed.push(leg);
  return leg;
}

export async function probeAdapterInfo(): Promise<{ readonly vendor?: string; readonly architecture?: string;
  readonly description?: string }> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter.");
  const info = adapter.info ?? {};
  return { vendor: info.vendor, architecture: info.architecture, description: info.description };
}
