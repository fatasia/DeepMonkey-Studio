import { ROBOT_IMPORT_LIMITS, type ModelRecord } from "@bim-studio/contracts";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { downloadBlob } from "../browserDownload";
import { loadViewerAssetBuffer } from "../viewer/viewerAssetTransport";
import { captureSceneThumbnail } from "../studio/sceneThumbnailCapture";

export function robotSourceFileName(model: Pick<ModelRecord, "name" | "format">): string {
  const name = model.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "robot";
  return name.toLowerCase().endsWith(`.${model.format}`) ? name : `${name}.${model.format}`;
}

export async function downloadRobotSource(model: ModelRecord, signal?: AbortSignal): Promise<void> {
  if (model.format !== "urdf" && model.format !== "zip") throw new Error("请选择机器人原始资源");
  signal?.throwIfAborted();
  const bytes = await loadViewerAssetBuffer(model.sourceUrl, "机器人原包", signal ? { signal } : undefined);
  signal?.throwIfAborted();
  const maximum = model.format === "urdf" ? ROBOT_IMPORT_LIMITS.xmlBytes : ROBOT_IMPORT_LIMITS.compressedBytes;
  if (bytes.byteLength !== model.size || bytes.byteLength > maximum) throw new Error("机器人原包大小与资源记录不符，请刷新后重试");
  downloadBlob(new Blob([bytes], { type: model.format === "zip" ? "application/zip" : "application/xml" }), robotSourceFileName(model));
}

/** 截取当前真实 Viewer 帧；失败明确反馈，不生成替代模型图片。 */
export function downloadRobotScreenshot(engine: ViewerEngine, sourceName: string): void {
  const image = captureSceneThumbnail(engine);
  if (!image) throw new Error("截图生成失败，请等待模型加载完成后重试");
  const encoded = image.slice(image.indexOf(",") + 1);
  const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
  downloadBlob(new Blob([bytes], { type: "image/jpeg" }), `${sourceName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\.[^.]+$/, "") || "robot"}.preview.jpg`);
}
