import JSZip from "jszip";
import {
  supportedExtensions,
  type ModelFormat,
  type ModelRecord,
  type SceneSnapshot
} from "@bim-studio/contracts";

interface ScenePackageAsset {
  originalModelId: string;
  sourceName: string;
  sourceFormat: ModelFormat;
  assetPath: string;
  fileName: string;
}

interface ScenePackageManifest {
  kind: "bim-studio-scene-package";
  schemaVersion: 1;
  scenePath: "scene.json";
  createdAt: string;
  assets: ScenePackageAsset[];
}

export interface ImportedSceneAsset extends Omit<ScenePackageAsset, "assetPath"> {
  file: File;
}

export interface ImportedSceneFile {
  scene: SceneSnapshot;
  assets: ImportedSceneAsset[];
  mode: "loose" | "package";
}

export function exportLooseScene(scene: SceneSnapshot): void {
  downloadBlob(
    new Blob([JSON.stringify(scene, null, 2)], { type: "application/json" }),
    `${safeFileStem(scene.name)}.scene.json`
  );
}

export function exportGlbFile(data: ArrayBuffer, sceneName: string): void {
  downloadBlob(new Blob([data], { type: "model/gltf-binary" }), `${safeFileStem(sceneName)}.glb`);
}

export function exportFbxFile(data: string, sceneName: string): void {
  downloadBlob(new Blob([data], { type: "application/octet-stream" }), `${safeFileStem(sceneName)}.fbx`);
}

export async function exportScenePackage(scene: SceneSnapshot, models: ModelRecord[]): Promise<void> {
  const zip = new JSZip();
  const assets: ScenePackageAsset[] = [];
  const usedModelIds = new Set<string>();

  for (const state of scene.models) {
    if (usedModelIds.has(state.modelId)) continue;
    usedModelIds.add(state.modelId);
    const record = models.find((item) => item.id === state.modelId);
    if (!record?.manifest?.geometryUrl || record.status !== "ready") {
      throw new Error(`模型“${state.sourceName ?? state.name}”尚无可打包的浏览资源`);
    }
    const extension = portableExtension(record.manifest.geometryUrl);
    if (!extension) throw new Error(`模型“${record.name}”的浏览资源格式无法打包`);
    if (extension === "gltf") {
      throw new Error(`模型“${record.name}”是零散 glTF，请先转为 GLB 后再导出单文件场景`);
    }
    const response = await fetch(record.manifest.geometryUrl);
    if (!response.ok) throw new Error(`下载模型“${record.name}”失败：${response.status}`);
    const fileName = `${safeFileStem(record.name)}.${extension}`;
    const assetPath = `models/${String(assets.length + 1).padStart(3, "0")}-${fileName}`;
    zip.file(assetPath, await response.arrayBuffer());
    assets.push({
      originalModelId: state.modelId,
      sourceName: state.sourceName ?? record.name,
      sourceFormat: state.sourceFormat ?? record.format,
      assetPath,
      fileName
    });
  }

  const manifest: ScenePackageManifest = {
    kind: "bim-studio-scene-package",
    schemaVersion: 1,
    scenePath: "scene.json",
    createdAt: new Date().toISOString(),
    assets
  };
  zip.file("package.json", JSON.stringify(manifest, null, 2));
  zip.file("scene.json", JSON.stringify(scene, null, 2));
  downloadBlob(await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } }), `${safeFileStem(scene.name)}.bimscene`);
}

export async function readSceneFile(file: File): Promise<ImportedSceneFile> {
  if (!file.name.toLowerCase().endsWith(".bimscene")) {
    return { scene: parseScene(await file.text()), assets: [], mode: "loose" };
  }

  const zip = await JSZip.loadAsync(file);
  const manifestEntry = zip.file("package.json");
  if (!manifestEntry) throw new Error("单文件场景缺少 package.json");
  const manifest = JSON.parse(await manifestEntry.async("text")) as ScenePackageManifest;
  if (manifest.kind !== "bim-studio-scene-package" || manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets)) {
    throw new Error("单文件场景格式无效或版本不受支持");
  }
  const sceneEntry = zip.file(manifest.scenePath);
  if (!sceneEntry) throw new Error("单文件场景缺少 scene.json");
  const scene = parseScene(await sceneEntry.async("text"));
  const assets: ImportedSceneAsset[] = [];
  for (const asset of manifest.assets) {
    const entry = zip.file(asset.assetPath);
    if (!entry) throw new Error(`单文件场景缺少模型资源：${asset.assetPath}`);
    const extension = asset.fileName.split(".").pop()?.toLowerCase();
    if (!extension || !supportedExtensions.includes(extension as ModelFormat)) {
      throw new Error(`模型资源格式不受支持：${asset.fileName}`);
    }
    assets.push({
      originalModelId: asset.originalModelId,
      sourceName: asset.sourceName,
      sourceFormat: asset.sourceFormat,
      fileName: asset.fileName,
      file: new File([await entry.async("blob")], asset.fileName)
    });
  }
  return { scene, assets, mode: "package" };
}

export function parseScene(text: string): SceneSnapshot {
  const scene = JSON.parse(text) as SceneSnapshot;
  if (scene.schemaVersion !== 1) throw new Error("不支持的场景文件版本");
  if (!Array.isArray(scene.models) || !Array.isArray(scene.primitives) || !Array.isArray(scene.measurements) || !scene.camera) {
    throw new Error("场景文件结构不完整");
  }
  return scene;
}

function portableExtension(url: string): ModelFormat | undefined {
  const pathname = new URL(url, window.location.origin).pathname;
  const extension = pathname.split(".").pop()?.toLowerCase();
  return supportedExtensions.find((item) => item === extension);
}

function safeFileStem(value: string): string {
  const withoutExtension = value.replace(/\.[^.]+$/, "");
  return withoutExtension.replace(/[\\/:*?"<>|]/g, "_").trim() || "scene";
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
