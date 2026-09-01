import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assessEnvironmentAssetPublication } from "./lib/environmentAssetPublication.mjs";

const OUTPUT = path.resolve(process.env.BIM_STUDIO_ENVIRONMENT_ASSET_CACHE ?? path.join(process.cwd(), "data", "external-assets", "environment-materials"));
const USER_AGENT = "BimStudioAssetSync/1.0";
const CONCURRENCY = Math.min(12, Math.max(1, numberArgument("--concurrency", 8)));
const HDRIS = [
  "industrial_sunset_puresky", "sunset_jhbcentral", "wide_street_01", "wide_street_02",
  "shanghai_bund", "canary_wharf", "studio_small_09", "studio_small_03",
  "dikhololo_night", "satara_night", "sunset_in_the_chalk_quarry", "hansaplatz",
];
const MATERIALS = [
  "concrete_floor_worn_001", "concrete_floor_02", "asphalt_02", "aerial_asphalt_01",
  "metal_plate", "green_metal_rust", "rust_coarse_01", "rusty_metal_02",
  "red_brick", "granite_tile", "floor_tiles_06", "white_plaster_02",
  "painted_plaster_wall", "plywood", "wood_floor", "rough_wood",
];
const MATERIAL_MAPS = [["Diffuse", "base-color"], ["nor_gl", "normal"], ["AO", "ao"], ["Rough", "roughness"], ["Metal", "metalness"]];

await mkdir(OUTPUT, { recursive: true });
const metadata = await apiJson("https://api.polyhaven.com/assets");
const assets = [];
const tasks = [];
for (const id of HDRIS) {
  const files = await apiJson(`https://api.polyhaven.com/files/${id}`);
  const file = files.hdri?.["4k"]?.hdr;
  if (!file) throw new Error(`${id} 缺少 4K HDR`);
  const thumbnail = metadata[id]?.thumbnail_url;
  tasks.push(fileTask(id, "environment", "environment.hdr", file));
  if (thumbnail) tasks.push(fileTask(id, "environment", "thumbnail.png", { url: thumbnail }));
  assets.push(assetRecord(id, "environment", metadata[id], [{ kind: "environment", fileName: "environment.hdr" }]));
}
for (const id of MATERIALS) {
  const files = await apiJson(`https://api.polyhaven.com/files/${id}`);
  const maps = [];
  for (const [sourceKey, kind] of MATERIAL_MAPS) {
    const file = files[sourceKey]?.["2k"]?.jpg;
    if (!file) continue;
    const fileName = `${kind}.jpg`;
    tasks.push(fileTask(id, "material", fileName, file));
    maps.push({ kind, fileName });
  }
  const thumbnail = metadata[id]?.thumbnail_url;
  if (thumbnail) tasks.push(fileTask(id, "material", "thumbnail.png", { url: thumbnail }));
  assets.push(assetRecord(id, "material", metadata[id], maps));
}

let completed = 0;
let downloadedBytes = 0;
console.log(`环境与材质 ${assets.length} 项、${tasks.length} 个文件，并发 ${CONCURRENCY}`);
await runPool(tasks, CONCURRENCY, async (task) => {
  const target = path.join(OUTPUT, task.category, task.id, task.fileName);
  await mkdir(path.dirname(target), { recursive: true });
  const existing = await fileStat(target);
  if (!existing) {
    const downloaded = await download(task.url, `${target}.part`, target);
    downloadedBytes += downloaded;
  }
  const file = await stat(target);
  task.bytes = file.size;
  task.sha256 = await hashFile(target);
  completed += 1;
  if (completed % 10 === 0 || completed === tasks.length) console.log(`进度 ${completed}/${tasks.length}，本次下载 ${formatBytes(downloadedBytes)}`);
});

for (const asset of assets) {
  asset.files = tasks.filter((task) => task.id === asset.id).map(({ category, id, url, ...file }) => file);
  asset.totalBytes = asset.files.reduce((sum, file) => sum + file.bytes, 0);
  const publication = assessEnvironmentAssetPublication(asset);
  asset.publicationStatus = publication.ready ? "published" : "review-required";
  asset.qualityIssues = publication.issues;
}
await writeJsonAtomically(path.join(OUTPUT, "catalog.json"), {
  schemaVersion: 1,
  libraryMode: "unified",
  generatedAt: new Date().toISOString(),
  resolutionPolicy: { environment: "4k-hdr", material: "2k-jpg" },
  assets,
});
console.log(`环境与材质索引已写入，共 ${formatBytes(assets.reduce((sum, asset) => sum + asset.totalBytes, 0))}`);

function assetRecord(id, category, meta, maps) {
  return {
    id, category, name: meta?.name ?? id, description: meta?.description ?? "",
    tags: meta?.tags ?? [], sourceCategory: meta?.category ?? "", maps,
    license: "CC0-1.0", publicationStatus: "review-required",
  };
}

function fileTask(id, category, fileName, file) {
  return { id, category, fileName, url: file.url, ...(file.md5 ? { expectedMd5: file.md5 } : {}) };
}

async function apiJson(url) {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${url} 返回 HTTP ${response.status}`);
  return response.json();
}

async function download(url, partialPath, targetPath) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const partial = await fileStat(partialPath);
      const offset = partial?.size ?? 0;
      const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, ...(offset ? { Range: `bytes=${offset}-` } : {}) }, signal: AbortSignal.timeout(900_000) });
      if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`);
      if (!response.body) throw new Error("下载响应没有内容");
      const append = offset > 0 && response.status === 206;
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partialPath, { flags: append ? "a" : "w" }));
      await rename(partialPath, targetPath);
      const complete = await stat(targetPath);
      return append ? complete.size - offset : complete.size;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError;
}

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) await worker(items[cursor++]);
  }));
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function fileStat(filePath) {
  try { return await stat(filePath); }
  catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
}

async function writeJsonAtomically(filePath, value) {
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function numberArgument(name, fallback) {
  const value = process.argv.find((argument) => argument.startsWith(`${name}=`));
  const parsed = Number(value?.slice(name.length + 1));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatBytes(bytes) {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
