// Sketchfab CC0/CC-BY 工业模型同步（source-b 通道）。
// key 读取 data/external-assets/source-b/api-keys.env（gitignored）；许可过滤：仅 CC0 与 CC-BY（BY 记 attribution）。
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const OUTPUT = path.resolve(process.env.BIM_STUDIO_SOURCE_B_CACHE ?? path.join(process.cwd(), "data", "external-assets", "source-b"));
const KEYS_PATH = path.join(OUTPUT, "api-keys.env");
const TOKEN = (await readFile(KEYS_PATH, "utf8")).match(/SKETCHFAB_API_TOKEN=(\S+)/)?.[1];
if (!TOKEN) throw new Error("缺少 SKETCHFAB_API_TOKEN（data/external-assets/source-b/api-keys.env）");
const USER_AGENT = "BimStudioAssetSync/1.0";
const CONCURRENCY = 4;
const MODELS_PER_KEYWORD = Math.min(60, Math.max(1, Number(process.argv.find((a) => a.startsWith("--per-keyword="))?.split("=")[1] ?? 12)));
const MAX_BYTES_PER_MODEL = 80 * 1024 * 1024;

// 工业缺口关键词：泵/阀/输送/叉车/仓储/机器人/电气柜/电机/罐体/起重机/暖通/防护栏
const KEYWORDS = process.argv.find((a) => a.startsWith("--keywords="))?.split("=")[1]?.split(",")
  ?? ["pump", "valve", "conveyor belt", "forklift", "warehouse pallet", "industrial robot arm", "electrical cabinet", "electric motor", "storage tank industrial", "crane hook", "hvac unit", "safety barrier"];

const ALLOWED_LICENSES = new Set(["cc0", "cc-by"]);

await mkdir(path.join(OUTPUT, "models"), { recursive: true });
await mkdir(path.join(OUTPUT, "thumbnails"), { recursive: true });
const catalogPath = path.join(OUTPUT, "catalog.json");
const previous = await readJson(catalogPath);
const known = new Map((previous?.models ?? []).map((item) => [item.uid, item]));
const collected = [];
const skipped = { license: 0, notDownloadable: 0, tooLarge: 0, noGlb: 0, errors: 0 };

for (const keyword of KEYWORDS) {
  const url = `https://api.sketchfab.com/v3/search?type=models&q=${encodeURIComponent(keyword)}&downloadable=true&count=24&sort=relevance`;
  const results = await apiJson(url).then((data) => data.results ?? []).catch(() => []);
  let taken = 0;
  for (const item of results) {
    if (taken >= MODELS_PER_KEYWORD) break;
    const licenseLabel = String(item.license?.label ?? "");
    const license = /cc0/i.test(licenseLabel) ? "cc0" : /^CC Attribution$/i.test(licenseLabel) ? "cc-by" : "";
    if (!license) { skipped.license += 1; continue; }
    if (!item.isDownloadable) { skipped.notDownloadable += 1; continue; }
    if (known.has(item.uid)) { collected.push(known.get(item.uid)); taken += 1; continue; }
    const download = await apiJson(`https://api.sketchfab.com/v3/models/${item.uid}/download`).catch(() => null);
    if (!download?.glb?.url) { skipped.noGlb += 1; continue; }
    if (Number(download.glb.size ?? 0) > MAX_BYTES_PER_MODEL) { skipped.tooLarge += 1; continue; }
    try {
      const modelFile = path.join(OUTPUT, "models", `${item.uid}.glb`);
      await downloadFile(download.glb.url, `${modelFile}.part`, modelFile);
      const thumbnailUrl = item.thumbnails?.images?.toSorted?.((a, b) => a.width - b.width)?.at(-1)?.url ?? item.thumbnails?.images?.[0]?.url;
      let thumbnailFile;
      if (thumbnailUrl) {
        thumbnailFile = path.join(OUTPUT, "thumbnails", `${item.uid}.png`);
        await downloadFile(thumbnailUrl, `${thumbnailFile}.part`, thumbnailFile).catch(() => undefined);
      }
      const record = {
        uid: item.uid,
        name: item.name,
        keyword,
        author: item.user?.username ?? "",
        license,
        originUrl: `https://sketchfab.com/3d-models/${item.uid}`,
        attribution: license === "cc0" ? undefined : (item.user?.username ? `© ${item.user.username} (Sketchfab, ${license.toUpperCase()})` : undefined),
        fileName: `${item.uid}.glb`,
        thumbnailName: thumbnailFile ? `${item.uid}.png` : undefined,
        bytes: (await stat(modelFile)).size,
        sha256: await hashFile(modelFile),
        synchronizedAt: new Date().toISOString(),
        publicationStatus: "review-required",
      };
      known.set(item.uid, record);
      collected.push(record);
      taken += 1;
    } catch {
      skipped.errors += 1;
    }
  }
  console.log(`关键词 "${keyword}"：累计 ${collected.length}，跳过 ${JSON.stringify(skipped)}`);
}

const records = [...known.values()].sort((left, right) => left.uid.localeCompare(right.uid));
await writeJsonAtomically(catalogPath, {
  schemaVersion: 1,
  libraryMode: "unified",
  generatedAt: new Date().toISOString(),
  source: "sketchfab",
  licensePolicy: "CC0 / CC-BY（BY 记 attribution）",
  models: records,
});
console.log(`完成：本次新增 ${collected.filter((item) => !item.synchronizedAt?.startsWith(new Date().toISOString().slice(0, 10)) ? true : true).length} 条记录，目录共 ${records.length} 个模型`);

async function apiJson(url) {
  const response = await fetch(url, { headers: { Authorization: `Token ${TOKEN}`, "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error(`${url.slice(0, 60)} → HTTP ${response.status}`);
  return response.json();
}

async function downloadFile(url, partialPath, targetPath) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(600_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!response.body) throw new Error("空响应");
      await pipeline(Readable.fromWeb(response.body), createWriteStream(targetPath));
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  throw lastError;
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function readJson(filePath) {
  try { return JSON.parse(await readFile(filePath, "utf8")); } catch { return null; }
}

async function writeJsonAtomically(filePath, value) {
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}
