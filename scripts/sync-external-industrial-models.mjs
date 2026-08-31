import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const ORIGIN = process.env.BIM_STUDIO_EXTERNAL_MODEL_ORIGIN?.replace(/\/$/, "");
if (!ORIGIN) throw new Error("请设置 BIM_STUDIO_EXTERNAL_MODEL_ORIGIN 后再同步外部模型目录");
const OUTPUT_DIRECTORY = path.resolve(process.env.BIM_STUDIO_ASSET_CACHE ?? path.join(process.cwd(), "data", "external-assets", "source-a"));
const CONCURRENCY = Math.min(8, Math.max(1, numberArgument("--concurrency", 4)));
const MODELS_ONLY = process.argv.includes("--models-only");
const METADATA_ONLY = process.argv.includes("--metadata-only");
const MANIFEST_PATH = path.join(OUTPUT_DIRECTORY, "catalog.json");

await mkdir(path.join(OUTPUT_DIRECTORY, "models"), { recursive: true });
await mkdir(path.join(OUTPUT_DIRECTORY, "thumbnails"), { recursive: true });

const previousManifest = await readJson(MANIFEST_PATH);
const previousFiles = new Map((previousManifest?.files ?? []).map((item) => [item.relativePath, item]));
const models = await listModels();
const files = models.flatMap((model) => [
  fileTask(model, "model", model.glb, path.join("models", model.glb)),
  ...(MODELS_ONLY ? [] : [fileTask(model, "thumbnail", model.thumb, path.join("thumbnails", model.thumb))])
]);

console.log(`外部目录 ${models.length} 个模型，待核对 ${files.length} 个文件，并发 ${CONCURRENCY}`);

let completed = 0;
let downloadedBytes = 0;
const fileRecords = [];
const failures = [];
if (!METADATA_ONLY) {
  await runPool(files, CONCURRENCY, async (task) => {
    try {
      const record = await syncFile(task, previousFiles.get(task.relativePath));
      fileRecords.push(record);
      downloadedBytes += record.downloadedBytes;
    } catch (error) {
      failures.push({ relativePath: task.relativePath, message: error instanceof Error ? error.message : String(error) });
      console.warn(`跳过失败文件 ${task.relativePath}：${failures.at(-1).message}`);
    } finally {
      completed += 1;
    }
    if (completed % 25 === 0 || completed === files.length) {
      console.log(`进度 ${completed}/${files.length}，本次下载 ${formatBytes(downloadedBytes)}`);
    }
  });
}

const manifest = {
  schemaVersion: 1,
  source: {
    id: "external-industrial-models-a",
    name: "外部工业模型目录 A",
    url: `${ORIGIN}/`,
    catalogEndpoint: `${ORIGIN}/api/model/list`,
    synchronizedAt: new Date().toISOString(),
    storagePolicy: "external-cache-not-web-bundle"
  },
  statistics: summarize(models),
  failures,
  models,
  files: METADATA_ONLY ? previousManifest?.files ?? [] : fileRecords.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
};
await writeJsonAtomically(MANIFEST_PATH, manifest);
console.log(`索引已写入 ${MANIFEST_PATH}`);
if (failures.length > 0) {
  console.warn(`仍有 ${failures.length} 个文件失败；再次运行同一命令会从分片继续。`);
  process.exitCode = 1;
}

async function listModels() {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(`${ORIGIN}/api/model/list`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "", type: null, element: null, status: null, style: null, order: 1, latestMeta: null, offset: 0, limit: 5000 }),
        signal: AbortSignal.timeout(120_000)
      });
      if (!response.ok) throw new Error(`读取外部模型目录失败：HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.code !== 1000 || !Array.isArray(payload.data?.models)) throw new Error("外部模型目录响应结构不正确");
      return payload.data.models;
    } catch (error) {
      lastError = error;
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 1_500));
    }
  }
  throw lastError;
}

function fileTask(model, kind, sourceName, relativePath) {
  return { modelId: model.id, kind, sourceName, relativePath, url: `${ORIGIN}/files/${encodeURIComponent(sourceName)}` };
}

async function syncFile(task, previous) {
  const target = path.join(OUTPUT_DIRECTORY, task.relativePath);
  const existing = await fileStat(target);
  if (existing && previous?.bytes === existing.size && previous.sha256) {
    return { ...previous, downloadedBytes: 0 };
  }
  if (existing) {
    const sha256 = await hashFile(target);
    return record(task, existing.size, sha256, 0);
  }

  const partial = `${target}.part`;
  const downloadedBytes = await downloadWithRetry(task, partial, target);
  const complete = await stat(target);
  return record(task, complete.size, await hashFile(target), downloadedBytes);
}

async function downloadWithRetry(task, partial, target) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const partialStat = await fileStat(partial);
      const offset = partialStat?.size ?? 0;
      const response = await fetch(task.url, {
        headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
        signal: AbortSignal.timeout(600_000)
      });
      if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`);
      if (!response.body) throw new Error(`${task.sourceName} 下载响应没有内容`);
      const append = offset > 0 && response.status === 206;
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: append ? "a" : "w" }));
      await rename(partial, target);
      const complete = await stat(target);
      return append ? complete.size - offset : complete.size;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError ?? new Error(`${task.sourceName} 下载失败`);
}

function record(task, bytes, sha256, downloadedBytes) {
  return { modelId: task.modelId, kind: task.kind, sourceName: task.sourceName, relativePath: task.relativePath.replaceAll("\\", "/"), bytes, sha256, downloadedBytes };
}

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  }));
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function fileStat(filePath) {
  try { return await stat(filePath); } catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
}

async function readJson(filePath) {
  try { return JSON.parse(await readFile(filePath, "utf8")); } catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
}

async function writeJsonAtomically(filePath, value) {
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function summarize(models) {
  return {
    modelCount: models.length,
    declaredSizeKiB: models.reduce((sum, model) => sum + Number(model.size || 0), 0),
    animatedCount: models.filter((model) => model.haveAnimation).length,
    categories: Object.fromEntries([...new Set(models.map((model) => model.type?.name ?? "未分类"))].sort().map((name) => [name, models.filter((model) => (model.type?.name ?? "未分类") === name).length]))
  };
}

function numberArgument(name, fallback) {
  const entry = process.argv.find((argument) => argument.startsWith(`${name}=`));
  const parsed = Number(entry?.slice(name.length + 1));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatBytes(bytes) {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
