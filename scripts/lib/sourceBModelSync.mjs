import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { downloadAssetAtomically } from "./atomicAssetDownload.mjs";
import { readSourceBCatalog, sourceBModelId, sourceBModelLicense, validateSourceBGlb, validateSourceBThumbnail } from "./sourceBModelPolicy.mjs";

const MODEL_LIMIT = 80 * 1024 * 1024;
const THUMBNAIL_LIMIT = 8 * 1024 * 1024;

export async function syncSourceBModels({ output, keywords, perKeyword = 2, maxNew = 6, apiJson, download = downloadAssetAtomically, report = console.log }) {
  if (![perKeyword, maxNew].every(value => Number.isInteger(value) && value > 0 && value <= 60)) throw new Error("下载配额必须为1至60的整数");
  const root = path.resolve(output);
  await mkdir(root, { recursive: true });
  const catalogPath = path.join(root, "catalog.json");
  const lockPath = path.join(root, "catalog.sync.lock");
  const lock = await open(lockPath, "wx").catch(error => { if (error.code === "EEXIST") throw new Error("source-b同步锁已存在，拒绝并行覆盖目录；请先确认原同步进程状态"); throw error; });
  const statistics = { added: 0, reused: 0, updated: 0, downloadRequests: 0, skipped: { license: 0, notDownloadable: 0, tooLarge: 0, noGlb: 0, thumbnail: 0 }, errors: [] };
  try {
    const previous = await readSourceBCatalog(catalogPath);
    const known = new Map(previous.models.map(record => [record.uid, record]));
    const visited = new Set();
    const licenses = new Map();
    const checkpoint = () => writeCatalog(catalogPath, { ...previous, generatedAt: new Date().toISOString(), licensePolicy: "CC0-1.0 / CC-BY-4.0（完整署名与来源）", models: [...known.values()].sort((a, b) => a.uid.localeCompare(b.uid)) });
    for (const keyword of keywords) {
      if (statistics.added >= maxNew) break;
      let results;
      try {
        const response = await apiJson(`/search?type=models&q=${encodeURIComponent(keyword)}&downloadable=true&count=24&sort=relevance`);
        if (!Array.isArray(response.results)) throw new Error("搜索响应缺少结果数组");
        results = response.results;
      } catch (error) { statistics.errors.push({ keyword, message: error.message }); report(`搜索失败 ${keyword}：${error.message}`); continue; }
      let addedForKeyword = 0;
      for (const item of results) {
        if (addedForKeyword >= perKeyword || statistics.added >= maxNew) break;
        try {
          const uid = sourceBModelId(item.uid);
          if (visited.has(uid)) continue;
          visited.add(uid);
          // Search responses contain only uid/label. Resolve the official license once, not by guessing from the label.
          let license = item.license;
          if (!license?.url && license?.uid) {
            const licenseId = sourceBModelId(license.uid);
            if (!licenses.has(licenseId)) licenses.set(licenseId, apiJson(`/licenses/${licenseId}`));
            license = await licenses.get(licenseId);
          }
          const provenance = sourceBModelLicense({ ...item, license });
          if (!provenance) { statistics.skipped.license++; continue; }
          if (!item.isDownloadable) { statistics.skipped.notDownloadable++; continue; }
          const old = known.get(uid);
          const modelPath = path.join(root, "models", `${uid}.glb`);
          let inspection = await inspectExistingModel(modelPath, old);
          const reused = Boolean(inspection);
          if (!inspection) {
            // A candidate's download URL can consume provider quota even if no GLB is offered.
            if (statistics.downloadRequests >= maxNew * 4) break;
            statistics.downloadRequests++;
            const response = await apiJson(`/models/${uid}/download`);
            if (!response.glb?.url) { statistics.skipped.noGlb++; continue; }
            if (Number(response.glb.size) > MODEL_LIMIT) { statistics.skipped.tooLarge++; continue; }
            inspection = (await download(response.glb.url, modelPath, { maxBytes: MODEL_LIMIT, validate: validateSourceBGlb })).inspection;
          }
          const thumbnailPath = path.join(root, "thumbnails", `${uid}.png`);
          let thumbnailName = old?.sha256 === inspection.sha256 && await validExistingThumbnail(thumbnailPath) ? `${uid}.png` : undefined;
          if (!thumbnailName) {
            const thumbnail = [...(item.thumbnails?.images ?? [])].sort((a, b) => b.width - a.width).find(image => image.url);
            try {
              if (!thumbnail) throw new Error("模型没有预览图");
              await download(thumbnail.url, thumbnailPath, { maxBytes: THUMBNAIL_LIMIT, validate: validateSourceBThumbnail });
              thumbnailName = `${uid}.png`;
            } catch (error) { statistics.skipped.thumbnail++; report(`缩略图待补 ${uid}：${error.message}`); }
          }
          const record = { uid, name: String(item.name || uid), keyword, ...provenance, fileName: `${uid}.glb`, ...(thumbnailName ? { thumbnailName } : {}),
            bytes: inspection.bytes, sha256: inspection.sha256, modelAudit: inspection, synchronizedAt: new Date().toISOString(), publicationStatus: "review-required" };
          known.set(uid, record);
          try { await checkpoint(); }
          catch (error) { if (old) known.set(uid, old); else known.delete(uid); throw error; }
          if (!old) { statistics.added++; addedForKeyword++; }
          else if (reused) statistics.reused++;
          else statistics.updated++;
        } catch (error) { statistics.errors.push({ uid: String(item.uid), message: error.message }); report(`模型处理失败：${error.message}`); }
      }
      report(`关键词 ${keyword}：新增 ${statistics.added}，复用 ${statistics.reused}，修复 ${statistics.updated}，错误 ${statistics.errors.length}`);
    }
    return { ...statistics, total: known.size };
  } finally { await lock.close(); await unlink(lockPath); }
}

async function inspectExistingModel(filePath, record) {
  if (!record) return;
  try {
    const file = await stat(filePath);
    if (file.size > MODEL_LIMIT || file.size !== record.bytes) return;
    const result = await validateSourceBGlb(filePath, file.size);
    return result.sha256 === record.sha256 ? result : undefined;
  } catch { return undefined; }
}

async function validExistingThumbnail(filePath) {
  try {
    if ((await stat(filePath)).size > THUMBNAIL_LIMIT) return false;
    const image = await sharp(await readFile(filePath), { limitInputPixels: 20_000_000 }).metadata();
    return image.format === "png" && image.width >= 240 && image.height >= 160;
  } catch { return false; }
}

async function writeCatalog(target, value) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); await rename(temporary, target); }
  finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
