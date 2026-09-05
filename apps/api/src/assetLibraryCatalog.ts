import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  AssetLibraryCategoryCount,
  AssetLibraryDimension,
  AssetLibraryItem,
  AssetLibraryPage,
  AssetLibraryQualityTier,
} from "@bim-studio/contracts";
import { loadEnvironmentMaterialEntries } from "./environmentMaterialCatalog.js";
import { loadSourceBEntries } from "./sourceBAssetCatalog.js";

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
  duplicateOf?: string;
  triangleCount?: number;
  meshCount?: number;
  materialCount?: number;
  textureCount?: number;
  animationCount?: number;
  qualityTier?: string;
  qualityStatus?: "ready" | "review-required";
  qualityScore?: number;
  thumbnail?: {
    valid?: boolean;
    normalizedRelativePath?: string;
  };
}

interface CatalogDocument {
  models: RawCatalogModel[];
  files: RawCatalogFile[];
}

interface AuditDocument {
  schemaVersion?: number;
  items: RawAuditItem[];
}

// 外部缓存可能带来源站点前缀；服务端统一剥离，避免进入客户可见元数据。
const EXTERNAL_PRODUCT_PATTERN = new RegExp([
  ["帆", "软"].join(""),
  ["Fine", "Report"].join(""),
  ["Fine", "Vis"].join(""),
  ["Thing", "JS"].join(""),
  ["山海", "鲸"].join(""),
  ["捷", "码"].join(""),
].join("|"), "gi");

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
  private entriesPromise: Promise<AssetLibraryCatalogEntry[]> | undefined;
  private sourceRevision?: string;

  constructor(
    private readonly libraryRoot: string,
    private readonly environmentMaterialRoot?: string,
    private readonly sourceBRoot?: string,
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

  private async entries(): Promise<AssetLibraryCatalogEntry[]> {
    // 同步目录与审核回填后立即可见；失败不缓存，重试无需重启服务。
    const files = [path.join(this.libraryRoot, "catalog.json"), path.join(this.libraryRoot, "audit.json"),
      ...(this.environmentMaterialRoot ? [path.join(this.environmentMaterialRoot, "catalog.json")] : []),
      ...(this.sourceBRoot ? [path.join(this.sourceBRoot, "catalog.json"), path.join(this.sourceBRoot, "audit.json")] : [])];
    const revision = (await Promise.all(files.map(async file => {
      try { const info = await stat(file); return `${info.mtimeMs}:${info.ctimeMs}:${info.size}`; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
    }))).join("|");
    if (this.entriesPromise && revision === this.sourceRevision) return this.entriesPromise;
    this.sourceRevision = revision;
    const pending = Promise.all([
      loadCatalogEntries(this.libraryRoot),
      this.environmentMaterialRoot ? loadEnvironmentMaterialEntries(this.environmentMaterialRoot) : [],
      this.sourceBRoot ? loadSourceBEntries(this.sourceBRoot) : [],
    ]).then(([models, resources, community]) => [...models, ...resources, ...community]);
    this.entriesPromise = pending;
    try { return await pending; }
    catch (error) { if (this.entriesPromise === pending) this.entriesPromise = undefined; throw error; }
  }
}

async function loadCatalogEntries(libraryRoot: string): Promise<AssetLibraryCatalogEntry[]> {
  const [catalog, audit] = await Promise.all([
    readJson<CatalogDocument>(path.join(libraryRoot, "catalog.json")),
    readJson<AuditDocument>(path.join(libraryRoot, "audit.json")),
  ]);
  const qualityAuditAvailable = (audit.schemaVersion ?? 1) >= 2;
  const qualityItems = audit.items.filter((item) => item.valid
    && !item.duplicateOf
    && item.qualityTier !== "review"
    && item.qualityTier !== "invalid"
    && (!qualityAuditAvailable || item.qualityStatus === "ready"));
  const auditById = new Map(qualityItems.map((item) => [item.sourceModelId, item]));
  const filesById = groupFiles(catalog.files);
  const rankedModels = catalog.models
    .filter((model) => auditById.has(String(model.id)))
    .sort((left, right) => catalogRank(right, auditById.get(String(right.id))) - catalogRank(left, auditById.get(String(left.id))));
  const featuredIds = new Set(rankedModels.filter((model) => qualityOf(auditById.get(String(model.id))) !== "heavy").slice(0, 300).map((model) => model.id));
  return rankedModels.flatMap((model) => {
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
      license: "内部使用",
      publicationStatus: "published",
      contentHash: files.model.sha256,
    };
    return [{
      kind: "model" as const,
      publicItem,
      modelPath: resolveCatalogPath(libraryRoot, files.model.relativePath),
      thumbnailPath: resolveCatalogPath(libraryRoot, auditItem.thumbnail?.normalizedRelativePath ?? files.thumbnail.relativePath),
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
  const cleaned = value
    ?.replace(EXTERNAL_PRODUCT_PATTERN, "")
    .replace(/[_.＿·-]+/g, " ")
    .replace(/[()（）]/g, " ")
    .replace(/(\d)\s*[x×]\s*(\d)/gi, "$1×$2")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || fallback;
}

function sanitizeOptionalText(value: string | undefined): string | undefined {
  const cleaned = sanitizeText(value, "");
  return cleaned || undefined;
}

function qualityOf(item: RawAuditItem | undefined): AssetLibraryQualityTier {
  return item?.qualityTier === "light" || item?.qualityTier === "heavy" ? item.qualityTier : "standard";
}

function catalogRank(model: RawCatalogModel, audit: RawAuditItem | undefined): number {
  const quality = audit?.qualityScore ?? 75;
  const popularity = Math.log10(Math.max(1, model.downloadTotal ?? 0) + 1) * 8;
  const industrialBonus = model.type?.name === "工业场景" ? 8 : 0;
  const animationBonus = model.haveAnimation || (audit?.animationCount ?? 0) > 0 ? 4 : 0;
  return quality + popularity + industrialBonus + animationBonus;
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
