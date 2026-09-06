import type { ModelRecord, ProjectRecord } from "@bim-studio/contracts";
import { api } from "../api";
import { loadViewerAssetBuffer } from "../viewer/viewerAssetTransport";

const READY_TIMEOUT_MS = 2 * 60_000;

export async function uploadAndConvertForOptimizer(
  projectId: string,
  source: File,
  onProgress: (message: string) => void,
  signal?: AbortSignal,
): Promise<{ file: File; project: ProjectRecord; sourceModel: ModelRecord }> {
  signal?.throwIfAborted();
  onProgress("正在上传源模型并创建转换任务");
  const uploaded = await api.uploadModel(projectId, source);
  signal?.throwIfAborted();
  const project = await waitForOptimizerModel(projectId, uploaded.id, onProgress, signal);
  const sourceModel = project.models.find((model) => model.id === uploaded.id)!;
  return { file: await convertProjectModelToGlb(sourceModel, onProgress, signal), project, sourceModel };
}

export async function waitForOptimizerModel(
  projectId: string,
  modelId: string,
  onProgress: (message: string) => void = () => undefined,
  signal?: AbortSignal,
): Promise<ProjectRecord> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const project = await api.getProject(projectId);
    signal?.throwIfAborted();
    const model = project.models.find((item) => item.id === modelId);
    if (!model) throw new Error("模型转换任务不存在");
    onProgress(model.message || `模型转换中 ${model.progress}%`);
    if (model.status === "ready") return project;
    if (model.status === "failed" || model.status === "waiting_converter") throw new Error(model.message);
    await optimizerDelay(350, signal);
  }
  throw new Error("模型转换超时，可稍后从项目素材库继续优化");
}

export async function convertProjectModelToGlb(
  model: ModelRecord,
  onProgress: (message: string) => void = () => undefined,
  signal?: AbortSignal,
): Promise<File> {
  signal?.throwIfAborted();
  if (model.status !== "ready" || !model.manifest?.viewerKind || !model.manifest.geometryUrl) {
    throw new Error(model.message || "模型尚未转换为可查看资源");
  }
  if (model.format === "urdf" || model.format === "zip" || model.manifest.viewerKind === "urdf" || model.manifest.robot) throw new Error("机器人资源仅支持原包无损压缩，不能转换为静态 GLB 优化格式");
  onProgress(`正在把 ${model.format.toUpperCase()} 转换为优化工作格式`);
  // 已是GLB时直接读取原始字节，避免Viewer重导出丢失动画、扩展及作者信息。
  if (model.format === "glb") {
    const binary = await loadViewerAssetBuffer(model.sourceUrl, "源模型", signal ? { signal } : undefined);
    signal?.throwIfAborted();
    return new File([binary], /\.glb$/i.test(model.name) ? model.name : `${model.name}.glb`, { type: "model/gltf-binary" });
  }
  const { convertManifestToOptimizerGlb } = await import("./modelOptimizerViewerConversion");
  signal?.throwIfAborted();
  const binary = await convertManifestToOptimizerGlb(model.manifest, signal);
  signal?.throwIfAborted();
  return new File([binary], `${baseName(model.name)}.converted.glb`, { type: "model/gltf-binary" });
}

export function optimizedAssetFile(sourceName: string, binary: Uint8Array<ArrayBuffer>): File {
  return new File([binary], `${baseName(sourceName)}.optimized.glb`, { type: "model/gltf-binary" });
}

export function isDirectOptimizerInput(file: File): boolean {
  return /\.(glb|gltf)$/i.test(file.name);
}

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

function optimizerDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
