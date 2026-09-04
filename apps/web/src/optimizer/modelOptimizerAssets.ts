import type { ModelRecord, ProjectRecord } from "@bim-studio/contracts";
import { api } from "../api";

const READY_TIMEOUT_MS = 2 * 60_000;

export async function uploadAndConvertForOptimizer(
  projectId: string,
  source: File,
  onProgress: (message: string) => void,
): Promise<{ file: File; project: ProjectRecord; sourceModel: ModelRecord }> {
  onProgress("正在上传源模型并创建转换任务");
  const uploaded = await api.uploadModel(projectId, source);
  const project = await waitForOptimizerModel(projectId, uploaded.id, onProgress);
  const sourceModel = project.models.find((model) => model.id === uploaded.id)!;
  return { file: await convertProjectModelToGlb(sourceModel, onProgress), project, sourceModel };
}

export async function waitForOptimizerModel(
  projectId: string,
  modelId: string,
  onProgress: (message: string) => void = () => undefined,
): Promise<ProjectRecord> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const project = await api.getProject(projectId);
    const model = project.models.find((item) => item.id === modelId);
    if (!model) throw new Error("模型转换任务不存在");
    onProgress(model.message || `模型转换中 ${model.progress}%`);
    if (model.status === "ready") return project;
    if (model.status === "failed" || model.status === "waiting_converter") throw new Error(model.message);
    await new Promise((resolve) => window.setTimeout(resolve, 350));
  }
  throw new Error("模型转换超时，可稍后从项目素材库继续优化");
}

export async function convertProjectModelToGlb(
  model: ModelRecord,
  onProgress: (message: string) => void = () => undefined,
): Promise<File> {
  if (model.status !== "ready" || !model.manifest?.viewerKind || !model.manifest.geometryUrl) {
    throw new Error(model.message || "模型尚未转换为可查看资源");
  }
  onProgress(`正在把 ${model.format.toUpperCase()} 转换为优化工作格式`);
  const { convertManifestToOptimizerGlb } = await import("./modelOptimizerViewerConversion");
  const binary = await convertManifestToOptimizerGlb(model.manifest);
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
