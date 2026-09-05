import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { AssetAttribution } from "@bim-studio/contracts";
import type { AssetLibraryCatalogEntry } from "./assetLibraryCatalog.js";

interface SourceModel {
  uid: string; name: string; fileName: string; bytes: number; sha256: string;
  license: string; author: string; originUrl: string; licenseUrl: string; attribution: string; modifications: string;
  publicationStatus: string;
  modelAudit?: {
    valid: boolean; sha256: string; meshCount: number; primitiveCount: number; triangleCount: number;
    materialCount: number; textureCount: number; animationCount: number; externalUris: string[];
  };
}

interface VisualReview {
  uid: string; contentHash: string; status: "approved"; reviewedAt: string;
  displayName: string; category: string; tags: string[];
  thumbnail: { relativePath: string; sha256: string; modelHash: string; renderer: "studio-webgl"; width: number; height: number };
}

/** 来源缓存不是素材库；仅合并许可、结构、当前字节和真实渲染复核全部匹配的项。 */
export async function loadSourceBEntries(root: string): Promise<AssetLibraryCatalogEntry[]> {
  const catalog = await readOptional<{ schemaVersion: number; source: string; models: SourceModel[] }>(path.join(root, "catalog.json"));
  if (catalog === undefined) return [];
  if (!catalog || catalog.schemaVersion !== 1 || catalog.source !== "sketchfab" || !Array.isArray(catalog.models)) throw new Error("source-b 素材目录格式无效");
  const audit = await readOptional<{ schemaVersion: number; items: VisualReview[] }>(path.join(root, "audit.json"));
  if (audit === undefined) return [];
  if (!audit || audit.schemaVersion !== 1 || !Array.isArray(audit.items)) throw new Error("source-b 视觉复核记录格式无效");
  const reviews = new Map(audit.items.map(item => [item.uid, item]));
  if (reviews.size !== audit.items.length) throw new Error("source-b 视觉复核记录包含重复 UID");
  const ids = new Set<string>();
  const entries: AssetLibraryCatalogEntry[] = [];
  for (const model of catalog.models) {
    if (!/^[a-f0-9]{32}$/.test(model.uid) || ids.has(model.uid)) throw new Error("source-b 素材 UID 无效或重复");
    ids.add(model.uid);
    const review = reviews.get(model.uid);
    const attribution = attributionFor(model);
    if (!attribution || !review || !eligible(model, review)) continue;
    const modelPath = await verifiedPath(root, `models/${model.uid}.glb`, model.sha256, model.bytes);
    const thumbnailPath = await verifiedPath(root, review.thumbnail.relativePath, review.thumbnail.sha256);
    if (!modelPath || !thumbnailPath) continue;
    const thumbnail = await readFile(thumbnailPath);
    if (thumbnail.length < 24 || thumbnail.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
      || thumbnail.readUInt32BE(16) !== review.thumbnail.width || thumbnail.readUInt32BE(20) !== review.thumbnail.height) continue;
    const metrics = model.modelAudit!;
    const id = `community-${model.uid}`;
    entries.push({ kind: "model", modelPath, thumbnailPath, contentHash: model.sha256, publicItem: {
      id, name: review.displayName.trim(), dimension: "3d", category: review.category.trim(),
      format: "glb", size: model.bytes, triangleCount: metrics.triangleCount, meshCount: metrics.meshCount,
      materialCount: metrics.materialCount, textureCount: metrics.textureCount, animated: metrics.animationCount > 0,
      featured: true, qualityTier: metrics.triangleCount > 200_000 || model.bytes > 20 * 1024 * 1024 ? "heavy" : metrics.triangleCount < 60_000 ? "light" : "standard",
      thumbnailUrl: `/api/public/asset-library/items/${id}/thumbnail?v=${review.thumbnail.sha256}`,
      previewUrl: `/api/asset-library/items/${id}/preview?v=${model.sha256}`,
      tags: review.tags, version: "1.0.0", license: model.license, attribution,
      publicationStatus: "published", contentHash: model.sha256,
    } });
  }
  return entries;
}

function eligible(model: SourceModel, review: VisualReview): boolean {
  const metrics = model.modelAudit;
  return model.publicationStatus === "published" && model.fileName === `${model.uid}.glb`
    && Number.isSafeInteger(model.bytes) && model.bytes > 0
    && Boolean(metrics?.valid && metrics.sha256 === model.sha256 && metrics.meshCount > 0 && metrics.primitiveCount > 0
      && Array.isArray(metrics.externalUris) && metrics.externalUris.length === 0)
    && [metrics?.triangleCount, metrics?.meshCount, metrics?.primitiveCount, metrics?.materialCount, metrics?.textureCount, metrics?.animationCount].every(value => Number.isSafeInteger(value) && value! >= 0)
    && review.status === "approved" && Number.isFinite(Date.parse(review.reviewedAt))
    && typeof review.displayName === "string" && Boolean(review.displayName.trim())
    && typeof review.category === "string" && Boolean(review.category.trim())
    && Array.isArray(review.tags) && review.tags.every(tag => typeof tag === "string")
    && review.contentHash === model.sha256 && review.thumbnail?.modelHash === model.sha256
    && review.thumbnail.renderer === "studio-webgl" && review.thumbnail.relativePath === `reviewed-thumbnails/${model.uid}.png`
    && review.thumbnail.width >= 240 && review.thumbnail.width <= 1920 && review.thumbnail.height >= 160 && review.thumbnail.height <= 1440;
}

function attributionFor(model: SourceModel): AssetAttribution | undefined {
  const licenseUrl = model.license === "CC-BY-4.0" ? "https://creativecommons.org/licenses/by/4.0/"
    : model.license === "CC0-1.0" ? "https://creativecommons.org/publicdomain/zero/1.0/" : undefined;
  if (!licenseUrl || model.licenseUrl !== licenseUrl || model.originUrl !== `https://sketchfab.com/3d-models/${model.uid}`
    || ![model.author, model.attribution, model.modifications].every(value => typeof value === "string" && value.trim())) return;
  return { author: model.author, sourceUrl: model.originUrl, licenseUrl, text: model.attribution, modifications: model.modifications };
}

async function verifiedPath(root: string, relative: string, expectedHash: string, expectedBytes?: number): Promise<string | undefined> {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) return;
  try {
    const resolvedRoot = await realpath(root);
    const file = await realpath(path.join(root, relative));
    if (!file.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("source-b 素材路径越界");
    const info = await stat(file);
    if (!info.isFile() || (expectedBytes !== undefined && info.size !== expectedBytes)
      || info.size > (expectedBytes === undefined ? 10 * 1024 * 1024 : 128 * 1024 * 1024)) return;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex") === expectedHash ? file : undefined;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}

async function readOptional<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}
