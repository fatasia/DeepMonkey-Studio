import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { readDashboardWindowsExecutable } from "./dashboardWindowsExecutable.js";
import { threeSceneViewerCache, threeSceneViewerCacheDirectory } from "./threeSceneViewerCache.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cacheDirectory = threeSceneViewerCacheDirectory;

export async function inspectThreeSceneArchive(bytes: Uint8Array): Promise<{ projectId: string; sceneId: string; publishedAt: string }> {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const entry = zip.file("manifest.json");
  if (!entry) throw new Error("Three WebView 包缺少 manifest.json");
  const manifest = JSON.parse(await entry.async("string")) as Record<string, unknown>;
  if (manifest.kind !== "bim-studio-scene-client-package" || manifest.schemaVersion !== 1
    || manifest.purpose !== "delivery" || manifest.target !== "three-webview"
    || typeof manifest.projectId !== "string" || typeof manifest.sceneId !== "string"
    || typeof manifest.publishedAt !== "string") throw new Error("Three WebView 包身份无效");
  return { projectId: manifest.projectId, sceneId: manifest.sceneId, publishedAt: manifest.publishedAt };
}

/** Tauri 使用固定 target/config 路径，进程内串行构建并立即冻结输出字节。 */
export async function buildThreeSceneViewerExecutable(builderScript: string, archive: Uint8Array, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const cacheKey = createHash("sha256").update(archive).digest("hex");
  const cachedExecutable = path.join(cacheDirectory, `${cacheKey}.exe`);
  const run = async () => {
    try { return Buffer.from(await readDashboardWindowsExecutable(cachedExecutable, signal)); }
    catch { /* 排队期间可能由相同请求填充；未命中才继续。 */ }
    const directory = await mkdtemp(path.join(tmpdir(), "three-scene-viewer-"));
    try {
      const input = path.join(directory, "scene.bimscene.zip");
      await writeFile(input, archive, { flag: "wx" });
      const packageId = `webview-${Date.now().toString(36)}-${process.pid.toString(36)}`;
      await execute(process.execPath, [builderScript, "--client-package", input, "--package-id", packageId], signal);
      const executable = path.join(repositoryRoot, "apps", "desktop", "src-tauri", "target", "release", "bim-studio-desktop.exe");
      const bytes = Buffer.from(await readDashboardWindowsExecutable(executable, signal));
      await mkdir(cacheDirectory, { recursive: true });
      const temporary = path.join(cacheDirectory, `${cacheKey}.${process.pid}.${Date.now()}.tmp`);
      await writeFile(temporary, bytes, { flag: "wx" });
      await rm(cachedExecutable, { force: true });
      await rename(temporary, cachedExecutable);
      return bytes;
    } finally { await rm(directory, { recursive: true, force: true }); }
  };
  return threeSceneViewerCache.exclusive(run);
}

function execute(command: string, args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], signal });
    const errors: Buffer[] = []; let size = 0;
    child.stderr.on("data", (chunk: Buffer) => { if (size < 64 * 1024) { errors.push(chunk); size += chunk.length; } });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Three WebView 构建失败 (${code})：${Buffer.concat(errors).toString("utf8").slice(-2000)}`)));
  });
}
