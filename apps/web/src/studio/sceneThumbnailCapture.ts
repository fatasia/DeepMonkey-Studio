import type { ViewerEngine } from "../viewer/ViewerEngine";

/** 缩略图约束：宽 480px、JPEG 0.72、data URL 上限 ~160KB，防止撑大场景快照。 */
const MAX_WIDTH = 480;
const JPEG_QUALITY = 0.72;
const MAX_DATA_URL_LENGTH = 160_000;
const CAPTURE_TIMEOUT_MS = 1500;

/** 保存读取当前呈现帧；GPU 快照和 JPEG 编码都交给浏览器异步执行。 */
export async function captureSceneThumbnailAsync(engine: ViewerEngine | undefined): Promise<string | undefined> {
  if (!engine || typeof createImageBitmap !== "function") return undefined;
  const backend = engine.getRendererBackend();
  const author = engine.renderer.domElement;
  const canvas = backend === "webgl" ? author : author.parentElement?.querySelector<HTMLCanvasElement>(
    `canvas[data-renderer-backend="deep-${backend}"]`);
  if (!canvas?.width || !canvas.height) return undefined;
  let bitmap: ImageBitmap | undefined;
  let unsubscribe: (() => void) | undefined;
  let expired = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const current = () => !expired && engine.getRendererBackend() === backend && canvas.isConnected;
  const preparingDeep = () => backend === "webgl" && Boolean(author.parentElement?.querySelector(
    'canvas[data-renderer-preparing="true"]'));
  try {
    const capture = new Promise<string | undefined>(resolve => {
      let started = false;
      const finish = (value?: string) => resolve(current() ? value : undefined);
      unsubscribe = engine.subscribePresentationFrames(() => {
        if (started) return;
        started = true;
        // GPU canvas snapshots drain outstanding work even through toBlob. During
        // candidate admission keep the saved thumbnail instead of flushing its GPU queue.
        if (!current() || preparingDeep()) { finish(); return; }
        // createImageBitmap(GPU canvas) may synchronously drain the GPU queue.
        // Canvas.toBlob schedules its readback/encoder; decode that owned blob afterwards.
        try { canvas.toBlob(blob => {
        if (!blob || !current()) { finish(); return; }
        void createImageBitmap(blob).then(image => {
          if (!current()) { image.close(); finish(); return; }
          bitmap = image;
          const scale = Math.min(1, MAX_WIDTH / image.width);
          const target = document.createElement("canvas");
          target.width = Math.max(1, Math.round(image.width * scale));
          target.height = Math.max(1, Math.round(image.height * scale));
          const ctx = target.getContext("2d");
          if (!ctx) { finish(); return; }
          ctx.drawImage(image, 0, 0, target.width, target.height);
          target.toBlob(blob => {
            target.width = target.height = 0;
            if (!blob || !current() || blob.size > MAX_DATA_URL_LENGTH) { finish(); return; }
            const reader = new FileReader();
            reader.onerror = () => finish();
            reader.onload = () => {
              const dataUrl = typeof reader.result === "string" ? reader.result : "";
              finish(dataUrl.startsWith("data:image/jpeg") && dataUrl.length <= MAX_DATA_URL_LENGTH ? dataUrl : undefined);
            };
            reader.readAsDataURL(blob);
          }, "image/jpeg", JPEG_QUALITY);
        }).catch(() => finish());
        }, "image/jpeg", JPEG_QUALITY); } catch { finish(); }
      });
    });
    return await Promise.race([capture, new Promise<undefined>(resolve => {
      timeout = setTimeout(() => { expired = true; resolve(undefined); }, CAPTURE_TIMEOUT_MS);
    })]);
  } catch {
    return undefined;
  } finally {
    expired = true;
    if (timeout !== undefined) clearTimeout(timeout);
    unsubscribe?.();
    bitmap?.close();
  }
}

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
