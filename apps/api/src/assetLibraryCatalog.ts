import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  AssetLibraryCategoryCount,
  AssetLibraryDimension,
  AssetLibraryItem,
  AssetLibraryPage,
  AssetLibraryQualityTier,
} from "@bim-studio/contracts";
import { loadEnvironmentMaterialEntries } from "./environmentMaterialCatalog.js";

interface RawCatalogModel {
  id: number;
  name: string;
  downloadTotal?: number;
  haveAnimation?: boolean;
  type?: { name?: string };
  element?: { name?: string };
  style?: { name?: string };
}

interface RawCatalogFile {
  modelId: number;
  kind: "model" | "thumbnail";
  relativePath: string;
  bytes: number;
  sha256: string;
}

interface RawAuditItem {
  sourceModelId: string;
  valid: boolean;
  triangleCount?: number;
  meshCount?: number;
  materialCount?: number;
  textureCount?: number;
  animationCount?: number;
  qualityTier?: string;
}

interface CatalogDocument {
  models: RawCatalogModel[];
  files: RawCatalogFile[];
}

interface AuditDocument {
  items: RawAuditItem[];
}

export interface AssetLibraryQuery {
  search?: string;
  dimension?: AssetLibraryDimension | "all";
  category?: string;
  animated?: boolean;
  featured?: boolean;
  page?: number;
  pageSize?: number;
}

export interface AssetLibraryCatalogEntry {
  kind: "model" | "environment" | "material";
  publicItem: AssetLibraryItem;
  thumbnailPath: string;
  contentHash: string;
  modelPath?: string;
  assetFiles?: Awaited<ReturnType<typeof loadEnvironmentMaterialEntries>>[number]["assetFiles"];
}

/** 读取离线素材清单，并在服务端统一完成品牌清理、分页和安全路径解析。 */
export class AssetLibraryCatalog {
  private entriesPromise?: Promise<AssetLibraryCatalogEntry[]>;

  constructor(
    private readonly libraryRoot: string,
    private readonly environmentMaterialRoot?: string,
  ) {}

  async list(query: AssetLibraryQuery = {}): Promise<AssetLibraryPage> {
    const entries = await this.entries();
    const search = normalizeSearch(query.search);
    const dimensionEntries = query.dimension && query.dimension !== "all"
      ? entries.filter(({ publicItem }) => publicItem.dimension === query.dimension)
      : entries;
    const filtered = dimensionEntries.filter(({ publicItem }) => {
      if (query.category && query.category !== "all" && publicItem.category !== query.category) return false;
      if (query.animated !== undefined && publicItem.animated !== query.animated) return false;
      if (query.featured !== undefined && publicItem.featured !== query.featured) return false;
      return !search || searchableText(publicItem).includes(search);
    });
    const pageSize = boundedInteger(query.pageSize, 24, 1, 100);
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = boundedInteger(query.page, 1, 1, totalPages);
    const start = (page - 1) * pageSize;
    return {
      items: filtered.slice(start, start + pageSize).map(({ publicItem }) => publicItem),
      page,
      pageSize,
      total: filtered.length,
      totalPages,
      categories: countBy(dimensionEntries, (item) => item.publicItem.category),
      dimensions: countBy(entries, (item) => item.publicItem.dimension),
    };
  }

  async get(id: string): Promise<AssetLibraryCatalogEntry | undefined> {
    return (await this.entries()).find(({ publicItem }) => publicItem.id === id);
  }

  private entries(): Promise<AssetLibraryCatalogEntry[]> {
    this.entriesPromise ??= Promise.all([
      loadCatalogEntries(this.libraryRoot),
      this.environmentMaterialRoot ? loadEnvironmentMaterialEntries(this.environmentMaterialRoot) : [],
    ]).then(([models, resources]) => [...models, ...resources]);
    return this.entriesPromise;
  }
}

async function loadCatalogEntries(libraryRoot: string): Promise<AssetLibraryCatalogEntry[]> {
  const [catalog, audit] = await Promise.all([
    readJson<CatalogDocument>(path.join(libraryRoot, "catalog.json")),
    readJson<AuditDocument>(path.join(libraryRoot, "audit.json")),
  ]);
  const auditById = new Map(audit.items.filter((item) => item.valid).map((item) => [item.sourceModelId, item]));
  const filesById = groupFiles(catalog.files);
  const rankedModels = [...catalog.models].sort((left, right) => (right.downloadTotal ?? 0) - (left.downloadTotal ?? 0));
  const featuredIds = new Set(rankedModels.filter((model) => qualityOf(auditById.get(String(model.id))) !== "heavy").slice(0, 300).map((model) => model.id));
  return catalog.models.flatMap((model) => {
    const auditItem = auditById.get(String(model.id));
    const files = filesById.get(model.id);
    if (!auditItem || !files?.model || !files.thumbnail) return [];
    const id = `industrial-${model.id}`;
    const category = sanitizeText(model.type?.name, "工业模型");
    const subcategory = sanitizeOptionalText(model.element?.name);
    const style = sanitizeOptionalText(model.style?.name);
    const animated = Boolean(model.haveAnimation || (auditItem.animationCount ?? 0) > 0);
    const publicItem: AssetLibraryItem = {
      id,
      name: sanitizeText(model.name, `工业素材 ${model.id}`),
      dimension: "3d",
      category,
      ...(subcategory ? { subcategory } : {}),
      ...(style ? { style } : {}),
      format: "glb",
      size: files.model.bytes,
      triangleCount: auditItem.triangleCount ?? 0,
      meshCount: auditItem.meshCount ?? 0,
      materialCount: auditItem.materialCount ?? 0,
      textureCount: auditItem.textureCount ?? 0,
      animated,
      featured: featuredIds.has(model.id),
      qualityTier: qualityOf(auditItem),
      thumbnailUrl: `/api/public/asset-library/items/${id}/thumbnail`,
      previewUrl: `/api/asset-library/items/${id}/preview`,
      tags: unique([category, subcategory, style, animated ? "动画" : undefined]),
      version: "1.0.0",
      license: "内部许可",
      publicationStatus: "published",
      contentHash: files.model.sha256,
    };
    return [{
      kind: "model" as const,
      publicItem,
      modelPath: resolveCatalogPath(libraryRoot, files.model.relativePath),
      thumbnailPath: resolveCatalogPath(libraryRoot, files.thumbnail.relativePath),
      contentHash: files.model.sha256,
    }];
  });
}

function groupFiles(files: RawCatalogFile[]): Map<number, Partial<Record<RawCatalogFile["kind"], RawCatalogFile>>> {
  const result = new Map<number, Partial<Record<RawCatalogFile["kind"], RawCatalogFile>>>();
  for (const file of files) {
    const current = result.get(file.modelId) ?? {};
    current[file.kind] = file;
    result.set(file.modelId, current);
  }
  return result;
}

function resolveCatalogPath(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("素材清单包含越界路径");
  return resolved;
}

function sanitizeText(value: string | undefined, fallback: string): string {
  const cleaned = value?.replace(/帆软|FineReport|FineVis|ThingJS|山海鲸|捷码/gi, "").replace(/\s{2,}/g, " ").trim();
  return cleaned || fallback;
}

function sanitizeOptionalText(value: string | undefined): string | undefined {
  const cleaned = sanitizeText(value, "");
  return cleaned || undefined;
}

function qualityOf(item: RawAuditItem | undefined): AssetLibraryQualityTier {
  return item?.qualityTier === "light" || item?.qualityTier === "heavy" ? item.qualityTier : "standard";
}

function searchableText(item: AssetLibraryItem): string {
  return [item.name, item.category, item.subcategory, item.style, ...item.tags].filter(Boolean).join(" ").toLocaleLowerCase("zh-CN");
}

function normalizeSearch(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase("zh-CN") ?? "";
}

function countBy(entries: AssetLibraryCatalogEntry[], keyOf: (entry: AssetLibraryCatalogEntry) => string): AssetLibraryCategoryCount[] {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(keyOf(entry), (counts.get(keyOf(entry)) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ id: name, name, count })).sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value!)));
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}
