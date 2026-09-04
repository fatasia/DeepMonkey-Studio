import type { ViewerEngine } from "../viewer/ViewerEngine";

/** 缩略图约束：宽 480px、JPEG 0.72、data URL 上限 ~160KB，防止撑大场景快照。 */
const MAX_WIDTH = 480;
const JPEG_QUALITY = 0.72;
const MAX_DATA_URL_LENGTH = 160_000;

/**
 * 抓取当前 3D 视口画面作为场景缩略图。
 * 渲染器未开启 preserveDrawingBuffer，必须先同步重绘一帧再立即读取同一画布。
 * 任何失败（WebGPU 上下文、画布尺寸异常、超限）都返回 undefined，绝不阻断保存。
 */
export function captureSceneThumbnail(engine: ViewerEngine | undefined): string | undefined {
  if (!engine) return undefined;
  try {
    const canvas = engine.renderer.domElement;
    if (!canvas.width || !canvas.height) return undefined;
    engine.renderer.render(engine.scene, engine.camera);
    const scale = Math.min(1, MAX_WIDTH / canvas.width);
    const target = document.createElement("canvas");
    target.width = Math.max(1, Math.round(canvas.width * scale));
    target.height = Math.max(1, Math.round(canvas.height * scale));
    const ctx = target.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(canvas, 0, 0, target.width, target.height);
    const dataUrl = target.toDataURL("image/jpeg", JPEG_QUALITY);
    if (!dataUrl.startsWith("data:image/jpeg") || dataUrl.length > MAX_DATA_URL_LENGTH) return undefined;
    return dataUrl;
  } catch {
    return undefined;
  }
}
