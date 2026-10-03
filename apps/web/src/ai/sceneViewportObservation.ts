import type { ViewerEngine } from "../viewer/ViewerEngine";

/** 视口观测:截图(给人看)+ 数值指标(给不支持图像输入的模型看)。 */
export interface ViewportMetrics {
  width: number;
  height: number;
  /** 0–100 平均亮度。 */
  meanLuma: number;
  /** 与背景(四角平均色)明显不同的像素占比,0–1;近似"画面内容覆盖率"。 */
  contentRatio: number;
  /** 3×3 分区平均亮度(行优先)。 */
  grid: number[];
  fingerprint: string;
}

export interface ViewportObservation {
  dataUrl: string;
  metrics: ViewportMetrics;
  capturedAt: string;
}

const IMAGE_MAX_WIDTH = 1280;
const IMAGE_QUALITY = 0.82;
const ANALYSIS_WIDTH = 96;

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** 纯函数:对下采样后的 RGBA 做统计,便于脱离 DOM 测试。 */
export function analyzePixels(rgba: ArrayLike<number>, width: number, height: number): Omit<ViewportMetrics, "fingerprint" | "width" | "height"> {
  const at = (x: number, y: number) => (y * width + x) * 4;
  const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]].map(([x, y]) => at(x!, y!));
  const bg = [0, 1, 2].map(channel => corners.reduce((sum, index) => sum + rgba[index + channel]!, 0) / corners.length);
  const cells = Array.from({ length: 9 }, () => ({ sum: 0, count: 0 }));
  let total = 0, content = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = at(x, y);
      const r = rgba[index]!, g = rgba[index + 1]!, b = rgba[index + 2]!;
      const value = luma(r, g, b);
      total += value;
      if (Math.abs(r - bg[0]!) + Math.abs(g - bg[1]!) + Math.abs(b - bg[2]!) > 36) content += 1;
      const cell = cells[Math.min(2, Math.floor(y * 3 / height)) * 3 + Math.min(2, Math.floor(x * 3 / width))]!;
      cell.sum += value; cell.count += 1;
    }
  }
  const pixels = width * height;
  return {
    meanLuma: Math.round(total / pixels / 255 * 1000) / 10,
    contentRatio: Math.round(content / pixels * 1000) / 1000,
    grid: cells.map(cell => Math.round(cell.sum / Math.max(1, cell.count) / 255 * 1000) / 10),
  };
}

async function fingerprintOf(rgba: ArrayLike<number>): Promise<string> {
  const bytes = Uint8Array.from(rgba as ArrayLike<number>);
  if (globalThis.crypto?.subtle) {
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest.slice(0, 8), byte => byte.toString(16).padStart(2, "0")).join("");
  }
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

/**
 * 同步重绘一帧后读取同一画布(渲染器不保留绘制缓冲)。任何失败返回 undefined——
 * 观测缺失由闭环如实呈现,绝不阻断改动本身。
 */
export async function captureViewportObservation(engine: Pick<ViewerEngine, "renderer" | "scene" | "camera"> | undefined): Promise<ViewportObservation | undefined> {
  if (!engine) return undefined;
  try {
    const canvas = engine.renderer.domElement;
    if (!canvas.width || !canvas.height) return undefined;
    engine.renderer.render(engine.scene, engine.camera);
    const scale = Math.min(1, IMAGE_MAX_WIDTH / canvas.width);
    const image = document.createElement("canvas");
    image.width = Math.max(1, Math.round(canvas.width * scale));
    image.height = Math.max(1, Math.round(canvas.height * scale));
    const imageContext = image.getContext("2d");
    if (!imageContext) return undefined;
    imageContext.drawImage(canvas, 0, 0, image.width, image.height);
    const dataUrl = image.toDataURL("image/jpeg", IMAGE_QUALITY);
    if (!dataUrl.startsWith("data:image/jpeg")) return undefined;
    const small = document.createElement("canvas");
    small.width = ANALYSIS_WIDTH;
    small.height = Math.max(1, Math.round(ANALYSIS_WIDTH * canvas.height / canvas.width));
    const smallContext = small.getContext("2d", { willReadFrequently: true });
    if (!smallContext) return undefined;
    smallContext.drawImage(canvas, 0, 0, small.width, small.height);
    const pixels = smallContext.getImageData(0, 0, small.width, small.height).data;
    return {
      dataUrl,
      capturedAt: new Date().toISOString(),
      metrics: { width: canvas.width, height: canvas.height, ...analyzePixels(pixels, small.width, small.height), fingerprint: await fingerprintOf(pixels) },
    };
  } catch {
    return undefined;
  }
}
