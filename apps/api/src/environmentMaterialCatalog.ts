import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AssetLibraryItem, AssetLibraryPublicationStatus, ProjectAssetMapKind } from "@bim-studio/contracts";

interface RawEnvironmentMaterialCatalog {
  schemaVersion: number;
  assets: RawEnvironmentMaterialAsset[];
}

interface RawEnvironmentMaterialAsset {
  id: string;
  category: "environment" | "material";
  name: string;
  description?: string;
  tags?: string[];
  maps: Array<{ kind: string; fileName: string }>;
  license: string;
  publicationStatus: string;
  files: Array<{ fileName: string; bytes: number; sha256: string }>;
  totalBytes: number;
}

export interface EnvironmentMaterialCatalogEntry {
  kind: "environment" | "material";
  publicItem: AssetLibraryItem;
  thumbnailPath: string;
  contentHash: string;
  assetFiles: Array<{
    kind: ProjectAssetMapKind | "thumbnail";
    fileName: string;
    filePath: string;
    bytes: number;
    sha256: string;
  }>;
}

/** 仅接纳清单中已经展开、带哈希且实际存在的文件；压缩包不会进入运行目录。 */
export async function loadEnvironmentMaterialEntries(root: string): Promise<EnvironmentMaterialCatalogEntry[]> {
  const catalogPath = path.join(root, "catalog.json");
  let catalog: RawEnvironmentMaterialCatalog;
  try {
    catalog = JSON.parse(await readFile(catalogPath, "utf8")) as RawEnvironmentMaterialCatalog;
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw reason;
  }
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.assets)) throw new Error("环境材质目录版本无效");
  const entries = await Promise.all(catalog.assets.map((asset) => normalizeAsset(root, asset)));
  return entries.filter((entry): entry is EnvironmentMaterialCatalogEntry => Boolean(entry));
}

async function normalizeAsset(root: string, asset: RawEnvironmentMaterialAsset): Promise<EnvironmentMaterialCatalogEntry | undefined> {
  if (!/^[a-z0-9][a-z0-9_-]{0,95}$/i.test(asset.id)) throw new Error("环境材质目录包含非法资源标识");
  if (asset.category !== "environment" && asset.category !== "material") return undefined;
  const publicationStatus = publicationStatusOf(asset.publicationStatus);
  const filesByName = new Map(asset.files.map((file) => [file.fileName, file]));
  const thumbnail = filesByName.get("thumbnail.png");
  if (!thumbnail) return undefined;
  const maps = asset.maps.flatMap((map) => {
    const kind = mapKindOf(map.kind);
    const file = filesByName.get(map.fileName);
    return kind && file && isUsableFile(kind, map.fileName) ? [{ kind, file }] : [];
  });
  if (!hasRequiredMaps(asset.category, maps.map(({ kind }) => kind))) return undefined;
  const assetFiles = [
    ...maps.map(({ kind, file }) => ({ kind, fileName: file.fileName, filePath: safeCatalogPath(root, asset.category, asset.id, file.fileName), bytes: file.bytes, sha256: file.sha256 })),
    { kind: "thumbnail" as const, fileName: thumbnail.fileName, filePath: safeCatalogPath(root, asset.category, asset.id, thumbnail.fileName), bytes: thumbnail.bytes, sha256: thumbnail.sha256 },
  ];
  await Promise.all(assetFiles.map(async (file) => {
    const actual = await stat(file.filePath);
    if (!actual.isFile() || actual.size !== file.bytes || !/^[a-f0-9]{64}$/i.test(file.sha256)) throw new Error(`资源 ${asset.id} 文件校验信息无效`);
  }));
  const contentHash = createHash("sha256").update(assetFiles.map((file) => `${file.kind}:${file.sha256}`).sort().join("|")).digest("hex");
  const isEnvironment = asset.category === "environment";
  const id = `${isEnvironment ? "environment" : "material"}-${asset.id}`;
  const publicItem: AssetLibraryItem = {
    id,
    name: neutralText(asset.name, isEnvironment ? "环境光照" : "PBR 材质"),
    dimension: isEnvironment ? "environment" : "material",
    category: classifyAsset(asset),
    format: isEnvironment ? formatOf(maps[0]!.file.fileName) : "pbr",
    size: asset.totalBytes,
    triangleCount: 0,
    meshCount: 0,
    materialCount: isEnvironment ? 0 : 1,
    textureCount: maps.length,
    animated: false,
    featured: true,
    qualityTier: "standard",
    thumbnailUrl: `/api/public/asset-library/items/${id}/thumbnail`,
    previewUrl: `/api/public/asset-library/items/${id}/thumbnail`,
    tags: unique([...(asset.tags ?? []).map((tag) => neutralText(tag, "")), isEnvironment ? "HDRI" : "PBR"]),
    version: "1.0.0",
    license: neutralText(asset.license, "内部许可"),
    publicationStatus,
    contentHash,
    mapKinds: maps.map(({ kind }) => kind),
  };
  return { kind: asset.category, publicItem, thumbnailPath: assetFiles.at(-1)!.filePath, contentHash, assetFiles };
}

function safeCatalogPath(root: string, category: string, id: string, fileName: string): string {
  if (path.basename(fileName) !== fileName || /\.zip$/i.test(fileName)) throw new Error("环境材质目录包含非法文件名");
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, category, id, fileName);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("环境材质目录包含越界路径");
  return resolved;
}

function mapKindOf(value: string): ProjectAssetMapKind | undefined {
  return (["environment", "base-color", "normal", "ao", "roughness", "metalness"] as const).find((kind) => kind === value);
}

function isUsableFile(kind: ProjectAssetMapKind, fileName: string): boolean {
  const extension = path.extname(fileName).toLowerCase();
  return kind === "environment" ? [".hdr", ".exr"].includes(extension) : [".jpg", ".jpeg", ".png", ".webp"].includes(extension);
}

function hasRequiredMaps(category: RawEnvironmentMaterialAsset["category"], kinds: ProjectAssetMapKind[]): boolean {
  return category === "environment" ? kinds.includes("environment") : ["base-color", "normal", "roughness"].every((kind) => kinds.includes(kind as ProjectAssetMapKind));
}

function publicationStatusOf(value: string): AssetLibraryPublicationStatus {
  return value === "published" || value === "deprecated" ? value : "review-required";
}

function formatOf(fileName: string): "hdr" | "exr" {
  return path.extname(fileName).toLowerCase() === ".exr" ? "exr" : "hdr";
}

function classifyAsset(asset: RawEnvironmentMaterialAsset): string {
  const text = `${asset.name} ${(asset.tags ?? []).join(" ")}`.toLowerCase();
  if (asset.category === "environment") return /studio|photo/.test(text) ? "棚拍环境" : /city|street|building|roof|skyline/.test(text) ? "城市环境" : "自然环境";
  if (/metal|rust/.test(text)) return "金属表面";
  if (/wood|plywood/.test(text)) return "木材表面";
  return "建筑表面";
}

function neutralText(value: string | undefined, fallback: string): string {
  const cleaned = value?.replace(/\s{2,}/g, " ").trim();
  return cleaned || fallback;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
