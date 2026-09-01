import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { assessExternalAssetQuality } from "./lib/assetQualityAudit.mjs";
import { normalizeAssetThumbnail } from "./lib/assetThumbnailAudit.mjs";
import { inspectGlbFile } from "./lib/glbAudit.mjs";

const CACHE_DIRECTORY = path.resolve(process.env.BIM_STUDIO_ASSET_CACHE ?? path.join(process.cwd(), "data", "external-assets", "source-a"));
const POLICY_PATH = path.resolve(process.cwd(), "config", "asset-source-policies.json");
const VISUAL_REVIEW_PATH = path.resolve(process.cwd(), "config", "asset-visual-quality-overrides.json");
const REPORT_PATH = path.join(CACHE_DIRECTORY, "audit.json");
const SOURCE_ID = "external-industrial-models-a";
const CONCURRENCY = Math.min(6, Math.max(1, numberArgument("--concurrency", 3)));

const policies = await readJson(POLICY_PATH);
const visualReview = await readJson(VISUAL_REVIEW_PATH);
const policy = policies?.sources?.find((item) => item.id === SOURCE_ID);
if (!policy || policy.libraryMode !== "unified") throw new Error("外部素材源缺少统一素材库策略，拒绝扫描");
if (visualReview?.sourceId !== SOURCE_ID) throw new Error("素材视觉复核清单与当前素材源不匹配");
const visualReviewById = new Map((visualReview.reviewRequired ?? []).map((item) => [String(item.modelId), item]));

const sourceManifest = await readJson(path.join(CACHE_DIRECTORY, "catalog.json"));
const sourceFiles = new Map((sourceManifest?.files ?? []).map((item) => [item.relativePath, item]));
const sourceModels = new Map((sourceManifest?.models ?? []).map((item) => [String(item.id), item]));
const modelDirectory = path.join(CACHE_DIRECTORY, "models");
const thumbnailDirectory = path.join(CACHE_DIRECTORY, "thumbnails");
const normalizedThumbnailDirectory = path.join(CACHE_DIRECTORY, "thumbnails-normalized");
const modelEntries = (await readdir(modelDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".glb"))
  .sort((left, right) => left.name.localeCompare(right.name));
const partialFiles = (await Promise.all([listParts(modelDirectory), listParts(thumbnailDirectory)])).flat();
const items = [];
let completed = 0;

console.log(`开始审计 ${modelEntries.length} 个已落盘 GLB，并发 ${CONCURRENCY}`);
await runPool(modelEntries, CONCURRENCY, async (entry) => {
  const filePath = path.join(modelDirectory, entry.name);
  const relativePath = `models/${entry.name}`;
  const file = await stat(filePath);
  const inspection = await inspectGlbFile(filePath, file.size);
  const sourceFile = sourceFiles.get(relativePath);
  const sourceModel = sourceFile ? sourceModels.get(String(sourceFile.modelId)) : undefined;
  items.push({
    relativePath,
    ...inspection,
    ...(sourceFile?.modelId === undefined ? {} : { sourceModelId: String(sourceFile.modelId) }),
    ...(sourceModel?.name ? { sourceName: String(sourceModel.name).slice(0, 200) } : {}),
    ...(sourceModel?.type?.name ? { sourceCategory: String(sourceModel.type.name).slice(0, 100) } : {}),
    publicationStatus: policy.defaultPublicationStatus,
  });
  completed += 1;
  if (completed % 50 === 0 || completed === modelEntries.length) console.log(`审计进度 ${completed}/${modelEntries.length}`);
});

items.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
markDuplicates(items);
const thumbnails = await auditThumbnails(sourceManifest?.files ?? []);
const thumbnailByModelId = new Map(thumbnails.items.map((item) => [item.sourceModelId, item]));
for (const item of items) {
  const sourceModel = item.sourceModelId ? sourceModels.get(item.sourceModelId) : undefined;
  const quality = assessExternalAssetQuality(sourceModel, item, thumbnailByModelId.get(item.sourceModelId));
  const manualReview = visualReviewById.get(item.sourceModelId);
  item.thumbnail = thumbnailByModelId.get(item.sourceModelId);
  item.qualityStatus = manualReview ? "review-required" : quality.status;
  item.qualityScore = manualReview ? Math.min(69, quality.qualityScore) : quality.qualityScore;
  item.qualityIssues = [...quality.issues, ...(manualReview ? [`visual-review:${manualReview.reason}`] : [])];
  item.publicationStatus = item.qualityStatus === "ready" ? "published" : policy.defaultPublicationStatus;
}
const report = {
  schemaVersion: 2,
  sourceId: SOURCE_ID,
  generatedAt: new Date().toISOString(),
  syncState: sourceManifest ? "manifest-ready" : "downloading",
  library: {
    mode: policy.libraryMode,
    defaultPublicationStatus: policy.defaultPublicationStatus,
    requiredMetadata: policy.requiredMetadata,
  },
  statistics: summarize(items, thumbnails, partialFiles, policy.expectedModelCount),
  partialFiles,
  thumbnails,
  items,
};
await writeJsonAtomically(REPORT_PATH, report);
console.log(`审计报告已写入 ${REPORT_PATH}`);
console.log(`有效 ${report.statistics.validModels}/${report.statistics.downloadedModels}，质量达标 ${report.statistics.qualityReadyModels}，重复 ${report.statistics.duplicateModels}，待复核 ${report.statistics.reviewModels}，分片 ${partialFiles.length}`);

function markDuplicates(records) {
  const canonicalByHash = new Map();
  for (const item of records) {
    if (!item.valid) continue;
    const canonical = canonicalByHash.get(item.sha256);
    if (canonical) item.duplicateOf = canonical;
    else canonicalByHash.set(item.sha256, item.relativePath);
  }
}

async function auditThumbnails(files) {
  const thumbnailFiles = files.filter((file) => file.kind === "thumbnail");
  const items = [];
  let bytes = 0;
  await runPool(thumbnailFiles, CONCURRENCY, async (file) => {
    const sourcePath = resolveCachePath(file.relativePath);
    const normalizedRelativePath = `thumbnails-normalized/${file.modelId}.png`;
    const normalizedPath = path.join(normalizedThumbnailDirectory, `${file.modelId}.png`);
    try {
      const sourceFile = await stat(sourcePath);
      bytes += sourceFile.size;
      const result = await normalizeAssetThumbnail(sourcePath, normalizedPath);
      items.push({ sourceModelId: String(file.modelId), sourceRelativePath: file.relativePath, normalizedRelativePath, ...result });
    } catch (error) {
      items.push({
        sourceModelId: String(file.modelId),
        sourceRelativePath: file.relativePath,
        normalizedRelativePath,
        valid: false,
        qualityScore: 0,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });
  items.sort((left, right) => Number(left.sourceModelId) - Number(right.sourceModelId));
  const valid = items.filter((item) => item.valid);
  return {
    count: items.length,
    valid: valid.length,
    invalid: items.length - valid.length,
    normalized: valid.length,
    bytes,
    averageQualityScore: valid.length ? Math.round(valid.reduce((sum, item) => sum + item.qualityScore, 0) / valid.length) : 0,
    items,
  };
}

function summarize(records, thumbnails, parts, expectedModels) {
  const valid = records.filter((item) => item.valid);
  const qualityTiers = Object.fromEntries(["light", "standard", "heavy", "review", "invalid"].map((tier) => [tier, records.filter((item) => item.qualityTier === tier).length]));
  return {
    expectedModels,
    downloadedModels: records.length,
    completionPercent: expectedModels ? Number(((records.length / expectedModels) * 100).toFixed(1)) : undefined,
    validModels: valid.length,
    invalidModels: records.length - valid.length,
    duplicateModels: records.filter((item) => item.duplicateOf).length,
    qualityReadyModels: records.filter((item) => item.qualityStatus === "ready").length,
    reviewModels: records.filter((item) => item.qualityStatus !== "ready").length,
    averageQualityScore: records.length ? Math.round(records.reduce((sum, item) => sum + (item.qualityScore ?? 0), 0) / records.length) : 0,
    animatedModels: valid.filter((item) => item.animationCount > 0).length,
    totalTriangles: valid.reduce((sum, item) => sum + item.triangleCount, 0),
    totalBytes: records.reduce((sum, item) => sum + item.bytes, 0),
    qualityTiers,
    thumbnails,
    partialFiles: parts.length,
  };
}

function resolveCachePath(relativePath) {
  const resolved = path.resolve(CACHE_DIRECTORY, relativePath);
  if (!resolved.startsWith(`${CACHE_DIRECTORY}${path.sep}`)) throw new Error("素材清单包含越界路径");
  return resolved;
}

async function listParts(directory) {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".part"))
    .map((entry) => path.relative(CACHE_DIRECTORY, path.join(directory, entry.name)).replaceAll("\\", "/"));
}

async function runPool(itemsToRun, concurrency, worker) {
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < itemsToRun.length) {
      const index = cursor++;
      await worker(itemsToRun[index]);
    }
  }));
}

async function readJson(filePath) {
  try { return JSON.parse(await readFile(filePath, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
}

async function writeJsonAtomically(filePath, value) {
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function numberArgument(name, fallback) {
  const entry = process.argv.find((argument) => argument.startsWith(`${name}=`));
  const parsed = Number(entry?.slice(name.length + 1));
  return Number.isFinite(parsed) ? parsed : fallback;
}
