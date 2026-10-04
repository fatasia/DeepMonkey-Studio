import { readStudioQualityTelemetry } from "../viewer/StudioDeepQualityTelemetry";

/**
 * A/B 对比帧抓取:呈现画布同步 drawImage(缩略 JPEG)。
 * 必须在呈现帧回调内同步调用(WebGPU 画布内容在本帧任务内有效)。
 * 缩略上限 560px、JPEG 0.85 —— GI 差异属低频大面积亮度差,缩略后仍可判读;
 * 字节上限防 sessionStorage 撑爆,超限返回 undefined(诚实缺帧,不产半帧)。
 */
const MAX_WIDTH = 560;
const JPEG_QUALITY = 0.85;
const MAX_DATA_URL_LENGTH = 300_000;

export const GI_OFF_BASELINE_STORAGE_KEY = "bim-studio.gi-bake-bench.gi-off-baseline";

export interface BakeBenchSnapshot {
  readonly dataUrl: string;
  /** 抓帧时的 GI 状态(遥测面 sdfGi 指标在场 = 开)。 */
  readonly sdfGiOn: boolean;
  /** 抓帧时的呈现后端(webgl/webgpu),跨后端对比时面板如实披露。 */
  readonly backend: string;
  readonly capturedAtMs: number;
}

/** 定位视口内当前呈现画布:可见画布中取 DOM 序最后的(Deep 画布创建于作者画布之后)。 */
function presentableCanvas(container: HTMLElement | null): HTMLCanvasElement | undefined {
  if (!container) return undefined;
  const canvases = Array.from(container.querySelectorAll("canvas")) as HTMLCanvasElement[];
  const visible = canvases.filter(canvas => {
    if (!canvas.clientWidth || !canvas.clientHeight) return false;
    const style = getComputedStyle(canvas);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
  });
  return visible.at(-1);
}

/** 在呈现帧回调内同步调用;失败返回 undefined(调用方保留武装等下一帧)。 */
export function captureViewportCanvasFrame(container: HTMLElement | null, backend: string): BakeBenchSnapshot | undefined {
  try {
    const canvas = presentableCanvas(container);
    if (!canvas) return undefined;
    const scale = Math.min(1, MAX_WIDTH / canvas.clientWidth);
    const target = document.createElement("canvas");
    target.width = Math.max(1, Math.round(canvas.clientWidth * scale));
    target.height = Math.max(1, Math.round(canvas.clientHeight * scale));
    const context = target.getContext("2d");
    if (!context) return undefined;
    context.drawImage(canvas, 0, 0, target.width, target.height);
    const dataUrl = target.toDataURL("image/jpeg", JPEG_QUALITY);
    if (!dataUrl.startsWith("data:image/jpeg") || dataUrl.length > MAX_DATA_URL_LENGTH) return undefined;
    const sdfGiOn = (() => { try { return readStudioQualityTelemetry()?.latestSdfGi !== undefined; } catch { return false; } })();
    return { dataUrl, sdfGiOn, backend, capturedAtMs: Date.now() };
  } catch {
    return undefined;
  }
}
