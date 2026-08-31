import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectGlbFile } from "./lib/glbAudit.mjs";

const CACHE_DIRECTORY = path.resolve(process.env.BIM_STUDIO_ASSET_CACHE ?? path.join(process.cwd(), "data", "external-assets", "source-a"));
const POLICY_PATH = path.resolve(process.cwd(), "config", "asset-source-policies.json");
const REPORT_PATH = path.join(CACHE_DIRECTORY, "audit.json");
const SOURCE_ID = "external-industrial-models-a";
const CONCURRENCY = Math.min(6, Math.max(1, numberArgument("--concurrency", 3)));

const policies = await readJson(POLICY_PATH);
const policy = policies?.sources?.find((item) => item.id === SOURCE_ID);
if (!policy || policy.libraryMode !== "unified") throw new Error("外部素材源缺少统一素材库策略，拒绝扫描");

const sourceManifest = await readJson(path.join(CACHE_DIRECTORY, "catalog.json"));
const sourceFiles = new Map((sourceManifest?.files ?? []).map((item) => [item.relativePath, item]));
const sourceModels = new Map((sourceManifest?.models ?? []).map((item) => [String(item.id), item]));
const modelDirectory = path.join(CACHE_DIRECTORY, "models");
const thumbnailDirectory = path.join(CACHE_DIRECTORY, "thumbnails");
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
const thumbnails = await auditThumbnails(thumbnailDirectory);
const report = {
  schemaVersion: 1,
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
console.log(`有效 ${report.statistics.validModels}/${report.statistics.downloadedModels}，重复 ${report.statistics.duplicateModels}，待复核 ${report.statistics.reviewModels}，分片 ${partialFiles.length}`);

function markDuplicates(records) {
  const canonicalByHash = new Map();
  for (const item of records) {
    if (!item.valid) continue;
    const canonical = canonicalByHash.get(item.sha256);
    if (canonical) item.duplicateOf = canonical;
    else canonicalByHash.set(item.sha256, item.relativePath);
  }
}

async function auditThumbnails(directory) {
  const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && !entry.name.endsWith(".part"));
  let invalid = 0;
  let bytes = 0;
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    const file = await stat(filePath);
    bytes += file.size;
    const handle = await import("node:fs/promises").then(({ open }) => open(filePath, "r"));
    try {
      const signature = Buffer.alloc(12);
      const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
      if (bytesRead < 4 || !isImageSignature(signature)) invalid += 1;
    } finally {
      await handle.close();
    }
  }
  return { count: entries.length, invalid, bytes };
}

function isImageSignature(value) {
  const png = value.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff;
  const webp = value.toString("ascii", 0, 4) === "RIFF" && value.toString("ascii", 8, 12) === "WEBP";
  return png || jpeg || webp;
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
    reviewModels: records.filter((item) => item.qualityTier === "review" || !item.valid).length,
    animatedModels: valid.filter((item) => item.animationCount > 0).length,
    totalTriangles: valid.reduce((sum, item) => sum + item.triangleCount, 0),
    totalBytes: records.reduce((sum, item) => sum + item.bytes, 0),
    qualityTiers,
    thumbnails,
    partialFiles: parts.length,
  };
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
