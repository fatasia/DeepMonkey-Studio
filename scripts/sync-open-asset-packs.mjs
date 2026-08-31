import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const OUTPUT_DIRECTORY = path.resolve(process.env.BIM_STUDIO_OPEN_ASSET_CACHE ?? path.join(process.cwd(), "data", "external-assets", "open-packs"));
const CONCURRENCY = Math.min(12, Math.max(1, numberArgument("--concurrency", 8)));
const USER_AGENT = "BimStudioAssetSync/1.0";

// 只同步能补足工业园区、人物车辆、环境、VFX 和声音的高价值开放包。
const PACKS = [
  pack("city-roads", "3d-city", "https://kenney.nl/media/pages/assets/city-kit-roads/74288c9459-1787042796/kenney_city-kit-roads.zip"),
  pack("factory", "3d-industrial", "https://kenney.nl/media/pages/assets/factory-kit/edaac9d4f6-1777639602/kenney_factory-kit_3.0.zip"),
  pack("cars", "3d-transport", "https://kenney.nl/media/pages/assets/car-kit/1a312ec241-1775131960/kenney_car-kit.zip"),
  pack("characters", "3d-people", "https://kenney.nl/media/pages/assets/blocky-characters/8369c0cf30-1749547469/kenney_blocky-characters_20.zip"),
  pack("light-masks", "vfx", "https://kenney.nl/media/pages/assets/light-masks/6530e254f9-1775631687/kenney_light-masks-1.0.zip"),
  pack("skyboxes", "environment", "https://kenney.nl/media/pages/assets/skyboxes/6736ff5c10-1784123473/kenney_skyboxes.zip"),
  pack("city-industrial", "3d-industrial", "https://kenney.nl/media/pages/assets/city-kit-industrial/5fcb837741-1750838303/kenney_city-kit-industrial_1.0.zip"),
  pack("city-suburban", "3d-city", "https://kenney.nl/media/pages/assets/city-kit-suburban/2c871b7af2-1745479373/kenney_city-kit-suburban_20.zip"),
  pack("trains", "3d-transport", "https://kenney.nl/media/pages/assets/train-kit/cf8521d625-1727040883/kenney_train-kit.zip"),
  pack("animated-people", "3d-people", "https://kenney.nl/media/pages/assets/animated-characters-protagonists/608191acc4-1774773108/kenney_animated-characters-protagonists.zip"),
  pack("particles", "vfx", "https://kenney.nl/media/pages/assets/particle-pack/f8fe0f8cb8-1677578741/kenney_particle-pack.zip"),
  pack("smoke", "vfx", "https://kenney.nl/media/pages/assets/smoke-particles/23249a0d35-1677695171/kenney_smoke-particles.zip"),
  pack("interface-audio", "audio", "https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip"),
  pack("impact-audio", "audio", "https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip"),
];

await mkdir(OUTPUT_DIRECTORY, { recursive: true });
const previous = await readJson(path.join(OUTPUT_DIRECTORY, "catalog.json"));
const previousById = new Map((previous?.packs ?? []).map((item) => [item.id, item]));
const records = [];
let completed = 0;
let downloadedBytes = 0;

console.log(`开放素材包 ${PACKS.length} 个，并发 ${CONCURRENCY}`);
await runPool(PACKS, CONCURRENCY, async (item) => {
  const filePath = path.join(OUTPUT_DIRECTORY, item.fileName);
  const existing = await fileStat(filePath);
  const old = previousById.get(item.id);
  if (existing && old?.bytes === existing.size && old.sha256) records.push(old);
  else {
    const downloaded = existing ? 0 : await download(item.url, `${filePath}.part`, filePath);
    const file = await stat(filePath);
    downloadedBytes += downloaded;
    records.push({ ...item, bytes: file.size, sha256: await hashFile(filePath), synchronizedAt: new Date().toISOString() });
  }
  completed += 1;
  console.log(`进度 ${completed}/${PACKS.length}，本次下载 ${formatBytes(downloadedBytes)} · ${item.id}`);
});

const catalog = {
  schemaVersion: 1,
  libraryMode: "unified",
  generatedAt: new Date().toISOString(),
  packs: records.sort((left, right) => left.id.localeCompare(right.id)),
};
await writeJsonAtomically(path.join(OUTPUT_DIRECTORY, "catalog.json"), catalog);
console.log(`开放素材包索引已写入，共 ${formatBytes(records.reduce((sum, item) => sum + item.bytes, 0))}`);

function pack(id, category, url) {
  return { id, category, url, fileName: `${id}.zip`, license: "CC0-1.0", publicationStatus: "review-required" };
}

async function download(url, partialPath, targetPath) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const partial = await fileStat(partialPath);
      const offset = partial?.size ?? 0;
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, ...(offset ? { Range: `bytes=${offset}-` } : {}) },
        signal: AbortSignal.timeout(900_000),
      });
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
  const value = process.argv.find((argument) => argument.startsWith(`${name}=`));
  const parsed = Number(value?.slice(name.length + 1));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatBytes(bytes) {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
