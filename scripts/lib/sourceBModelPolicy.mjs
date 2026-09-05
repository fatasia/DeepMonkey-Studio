import { readFile, stat, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { AssetValidationError } from "./atomicAssetDownload.mjs";
import { inspectGlbFile } from "./glbAudit.mjs";

export function sourceBModelId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/i.test(value)) throw new AssetValidationError("模型UID格式无效");
  return value.toLowerCase();
}

/** License label alone does not establish its version or redistribution terms. */
export function sourceBModelLicense(model) {
  let url;
  try { url = new URL(model.license?.url); } catch { return; }
  if (!["http:", "https:"].includes(url.protocol) || !["creativecommons.org", "www.creativecommons.org"].includes(url.hostname.toLowerCase()) || url.username || url.password) return;
  const slug = url.pathname.replace(/\/$/, "");
  const license = slug === "/publicdomain/zero/1.0" ? "CC0-1.0" : slug === "/licenses/by/4.0" ? "CC-BY-4.0" : undefined;
  if (!license) return;
  const author = String(model.user?.displayName || model.user?.username || "").trim();
  if (license === "CC-BY-4.0" && !author) return;
  const uid = sourceBModelId(model.uid);
  const originUrl = `https://sketchfab.com/3d-models/${uid}`;
  const licenseUrl = `https://creativecommons.org${slug}/`;
  return { license, author, originUrl, licenseUrl, attribution: `${String(model.name || uid)} — ${author || "作者未署名"} / Sketchfab · ${license} · ${originUrl} · ${licenseUrl}`, modifications: "原始GLB未修改；预览图转为PNG，入库前需独立视觉复核" };
}

export async function readSourceBCatalog(filePath) {
  let source;
  try { source = await readFile(filePath, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return { schemaVersion: 1, source: "sketchfab", models: [] }; throw error; }
  const catalog = JSON.parse(source);
  if (catalog.schemaVersion !== 1 || catalog.source !== "sketchfab" || !Array.isArray(catalog.models)) throw new Error("source-b目录格式无效，原目录未覆盖");
  const ids = new Set();
  for (const record of catalog.models) {
    const id = sourceBModelId(record.uid);
    if (ids.has(id) || record.fileName !== `${id}.glb`) throw new Error("source-b目录包含重复UID或越界文件名");
    if (record.thumbnailName && record.thumbnailName !== `${id}.png`) throw new Error("source-b缩略图文件名无效");
    ids.add(id);
  }
  return catalog;
}

export async function validateSourceBGlb(filePath, bytes) {
  const result = await inspectGlbFile(filePath, bytes);
  if (!result.valid || !result.meshCount || !result.primitiveCount || result.externalUris.length) throw new AssetValidationError(result.reason || "模型无几何体或依赖外部资源，不适合单GLB入库");
  return result;
}

export async function validateSourceBThumbnail(filePath) {
  try {
    // Decode bounded downloaded bytes from memory; libvips can retain a file lock on Windows.
    const image = sharp(await readFile(filePath), { failOn: "error", limitInputPixels: 20_000_000 });
    const metadata = await image.metadata();
    if (!["png", "jpeg", "webp"].includes(metadata.format) || !metadata.width || !metadata.height || metadata.width < 240 || metadata.height < 160) throw new Error("预览图格式或分辨率不足");
    const png = await image.rotate().resize({ width: 960, height: 720, fit: "inside", withoutEnlargement: true }).png().toBuffer();
    await writeFile(filePath, png);
    return { valid: true, format: "png", bytes: (await stat(filePath)).size };
  } catch (error) { throw new AssetValidationError(`缩略图验证失败：${error.message}`); }
}
