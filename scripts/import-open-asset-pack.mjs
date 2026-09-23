import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import yauzl from "yauzl";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const source = args.find((value) => !value.startsWith("--"));
if (!source) throw new Error("用法：pnpm assets:import -- <目录或 .zip> [--target=<素材目录>]");
const targetArg = args.find((value) => value.startsWith("--target="))?.slice("--target=".length);
const target = path.resolve(root, targetArg ?? process.env.ASSET_LIBRARY_DIR ?? path.join("data", "external-assets", "source-a"));
const sourcePath = path.resolve(process.cwd(), source);
const staging = `${target}.import-${process.pid}-${Date.now()}`;

await mkdir(staging, { recursive: true });
try {
  const sourceInfo = await stat(sourcePath);
  if (sourceInfo.isDirectory()) await copyDirectory(sourcePath, staging);
  else if (sourcePath.toLowerCase().endsWith(".zip")) await extractZip(sourcePath, staging);
  else throw new Error("素材包必须是目录或 ZIP");
  const manifest = await readJson(path.join(staging, "pack.manifest.json"));
  if (!manifest || manifest.schemaVersion !== 1) throw new Error("素材包缺少 schemaVersion=1 的 pack.manifest.json");
  if (manifest.publicationStatus !== "published") throw new Error("素材包未标记为 published，不能导入公开素材目录");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("素材包 files 为空");
  await verifyManifest(staging, manifest.files);
  for (const required of ["catalog.json", "audit.json"]) {
    if (!await exists(path.join(staging, required))) throw new Error(`素材包缺少 ${required}`);
  }
  await validateCatalog(staging);
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await rename(staging, target);
  console.log(`开放素材包已导入：${path.relative(root, target)}`);
  console.log(`pack=${manifest.id} version=${manifest.version} files=${manifest.files.length} license=${manifest.license}`);
} catch (error) {
  await rm(staging, { recursive: true, force: true });
  throw error;
}

async function extractZip(file, destination) {
  // yauzl 3.x 是回调 API，不返回 Promise；直接 await 会得到 undefined。
  // 不启用 strictFileNames：Windows 常见压缩工具（如 PowerShell Compress-Archive）
  // 用反斜杠作条目分隔符，本脚本下方已统一归一为 "/"，越界仍由 safePath 拦截。
  const zip = await new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (error, archive) => error ? reject(error) : resolve(archive))
  );
  await new Promise((resolve, reject) => {
    zip.readEntry();
    zip.on("entry", (entry) => {
      const name = entry.fileName.replaceAll("\\", "/");
      if (!name || name.endsWith("/")) { zip.readEntry(); return; }
      const out = safePath(destination, name);
      mkdir(path.dirname(out), { recursive: true }).then(() => zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) { reject(error ?? new Error("ZIP 流为空")); return; }
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", async () => { try { await writeFile(out, Buffer.concat(chunks)); zip.readEntry(); } catch (reason) { reject(reason); } });
      })).catch(reject);
    });
    zip.on("end", resolve);
    zip.on("error", reject);
  });
  zip.close();
}

async function copyDirectory(sourceRoot, destination) {
  const { cp } = await import("node:fs/promises");
  await cp(sourceRoot, destination, { recursive: true, force: true, errorOnExist: false });
}

async function verifyManifest(directory, files) {
  const seen = new Set();
  for (const item of files) {
    if (!item || typeof item.path !== "string" || !/^[a-f0-9]{64}$/i.test(item.sha256)) throw new Error("素材包文件清单格式无效");
    const relative = item.path.replaceAll("\\", "/");
    if (seen.has(relative)) throw new Error(`素材包文件重复：${relative}`);
    seen.add(relative);
    const file = safePath(directory, relative);
    if (!await exists(file)) throw new Error(`素材包文件缺失：${relative}`);
    const digest = createHash("sha256");
    for await (const chunk of (await import("node:fs")).createReadStream(file)) digest.update(chunk);
    if (digest.digest("hex") !== item.sha256.toLowerCase()) throw new Error(`素材包哈希不匹配：${relative}`);
  }
}

async function validateCatalog(directory) {
  const catalog = await readJson(path.join(directory, "catalog.json"));
  const audit = await readJson(path.join(directory, "audit.json"));
  if (!Array.isArray(catalog?.models) || !Array.isArray(catalog?.files) || !Array.isArray(audit?.items)) throw new Error("catalog/audit 结构无效");
}

function safePath(base, relative) {
  if (path.posix.isAbsolute(relative) || relative.split("/").some((part) => part === ".." || part === "" && relative !== "")) throw new Error(`素材包路径越界：${relative}`);
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(base, relative);
  if (!resolved.startsWith(`${resolvedBase}${path.sep}`)) throw new Error(`素材包路径越界：${relative}`);
  return resolved;
}

async function readJson(file) { try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error?.code === "ENOENT") return undefined; throw error; } }
async function exists(file) { try { await stat(file); return true; } catch { return false; } }
