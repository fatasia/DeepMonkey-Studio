import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { AssetLibraryCatalogEntry } from "./assetLibraryCatalog.js";

interface NatureEntry {
  id: string; category: string; contentHash: string; bytes: number; groundedDerived: boolean;
  metrics: { valid: boolean; sha256: string; triangleCount: number; meshCount: number;
    materialCount: number; textureCount: number; animationCount: number; externalUris: string[] };
}
const categories: Record<string, string> = { trees: "树木", shrubs: "灌木", fences: "围栏", ground: "地面" };

/** 随包素材走同一目录与项目导入链；实例只引用持久化后的项目模型。 */
export async function loadNatureKitEntries(root: string): Promise<AssetLibraryCatalogEntry[]> {
  let raw: string;
  try { raw = await readFile(path.join(root, "catalog.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const document = JSON.parse(raw) as { schema: string; license: string; selectedCount: number; entries: NatureEntry[] };
  if (document.schema !== "deep-engine.v11-nature-kit-catalog" || document.license !== "CC0"
    || !Array.isArray(document.entries) || document.entries.length !== document.selectedCount) throw new Error("Nature Kit 目录无效");
  const ids = new Set<string>();
  return Promise.all(document.entries.map(async entry => {
    if (!/^kenney\.nature-kit\.[A-Za-z0-9_]+$/.test(entry.id) || ids.has(entry.id) || !categories[entry.category]) throw new Error("Nature Kit 素材身份无效");
    ids.add(entry.id);
    const metrics = entry.metrics;
    if (!metrics?.valid || metrics.sha256 !== entry.contentHash || !/^[a-f0-9]{64}$/.test(entry.contentHash)
      || metrics.externalUris.length || metrics.meshCount < 1
      || ![entry.bytes, metrics.triangleCount, metrics.meshCount, metrics.materialCount, metrics.textureCount, metrics.animationCount].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("Nature Kit 几何审计缺失");
    const modelPath = await contained(root, `models/${entry.id}.glb`);
    const thumbnailPath = await contained(root, `thumbnails/${entry.id}_NE.png`);
    const bytes = await readFile(modelPath);
    if (bytes.length !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.contentHash) throw new Error("Nature Kit 模型完整性校验失败");
    return { kind: "model", modelPath, thumbnailPath, contentHash: entry.contentHash, publicItem: {
      id: entry.id, name: entry.id.replace("kenney.nature-kit.", "").replaceAll("_", " "),
      dimension: "3d", category: "环境搭建", subcategory: categories[entry.category]!, style: "低多边形",
      format: "glb", size: entry.bytes, triangleCount: metrics.triangleCount, meshCount: metrics.meshCount,
      materialCount: metrics.materialCount, textureCount: metrics.textureCount, animated: metrics.animationCount > 0,
      featured: true, qualityTier: "light", thumbnailUrl: `/api/public/asset-library/items/${entry.id}/thumbnail`,
      previewUrl: `/api/asset-library/items/${entry.id}/preview`, tags: ["Nature Kit", entry.category, categories[entry.category]!],
      version: "2.1.0", license: "CC0-1.0", publicationStatus: "published", contentHash: entry.contentHash,
      attribution: { author: "Kenney", sourceUrl: "https://kenney.nl/assets/nature-kit",
        licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/", text: "Kenney Nature Kit 2.1 · CC0",
        modifications: entry.groundedDerived ? "校正贴地原点" : "未修改模型" },
    } } satisfies AssetLibraryCatalogEntry;
  }));
}

async function contained(root: string, relative: string): Promise<string> {
  const directory = await realpath(root), file = await realpath(path.join(directory, relative));
  if (!file.startsWith(`${directory}${path.sep}`)) throw new Error("Nature Kit 路径越界");
  return file;
}
