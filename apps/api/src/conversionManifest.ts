import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelManifest, ModelRecord, ViewerKind } from "@bim-studio/contracts";
import { generateGlbLods } from "./glbOptimizer.js";

export interface OutputCandidate {
  fileName: string;
  viewerKind: ViewerKind;
}

export function assetUrl(projectId: string, modelId: string, fileName: string): string {
  return `/assets/projects/${projectId}/models/${modelId}/${fileName}`;
}

export function assetKey(projectId: string, modelId: string, fileName: string): string {
  return `projects/${projectId}/models/${modelId}/${fileName}`.replace(/\/$/, "");
}

export async function findOutput(outputDir: string, candidates: OutputCandidate[]): Promise<OutputCandidate> {
  for (const candidate of candidates) {
    try {
      await access(path.join(outputDir, candidate.fileName));
      return candidate;
    } catch {
      // Try the next supported converter output.
    }
  }
  throw new Error(`转换器未生成受支持的产物：${candidates.map((item) => item.fileName).join(", ")}`);
}

export function createManifest(
  model: ModelRecord,
  viewerKind: ViewerKind,
  geometryUrl: string,
  hierarchyUrl?: string,
  propertiesUrl?: string,
  lods?: ModelManifest["lods"],
  pmiUrl?: string
): ModelManifest {
  return {
    schemaVersion: 1,
    modelId: model.id,
    sourceName: model.name,
    sourceFormat: model.format,
    viewerKind,
    geometryUrl,
    ...(hierarchyUrl ? { hierarchyUrl } : {}),
    ...(propertiesUrl ? { propertiesUrl } : {}),
    ...(pmiUrl ? { pmiUrl } : {}),
    ...(lods?.length ? { lods } : {}),
    createdAt: new Date().toISOString()
  };
}

export async function createLodResources(filePath: string, model: ModelRecord): Promise<ModelManifest["lods"]> {
  try {
    const generated = await generateGlbLods(filePath);
    return generated.map(({ fileName, level, ratio }) => ({
      level,
      ratio,
      url: assetUrl(model.projectId, model.id, `output/${fileName}`)
    }));
  } catch (error) {
    console.warn("LOD 生成失败，保留完整精度模型", error);
    return [];
  }
}

export async function optionalAsset(filePath: string, url: string): Promise<string | undefined> {
  try {
    await access(filePath);
    return url;
  } catch {
    return undefined;
  }
}

/** Deep Asset Package 的 facet 证据按实际落盘的 sidecar 标注，不虚构未产出的层级/属性。 */
export async function availableOutputSidecars(outputDir: string): Promise<{ hierarchy: boolean; properties: boolean }> {
  const check = async (fileName: string): Promise<boolean> => {
    try {
      await access(path.join(outputDir, fileName));
      return true;
    } catch {
      return false;
    }
  };
  return { hierarchy: await check("hierarchy.json"), properties: await check("properties.json") };
}

export async function writeManifest(modelDir: string, manifest: ModelManifest): Promise<void> {
  await writeFile(path.join(modelDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
}
