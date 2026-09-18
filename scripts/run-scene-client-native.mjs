import { createReadStream } from "node:fs";
import { mkdtemp, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import yauzl from "yauzl";
import { sceneClientArchiveLimits, verifySceneClientArchive } from "./lib/sceneClientArchive.mjs";
import { verifySceneNativeWindow } from "./verify-scene-native-window.mjs";

/** 只从同一次读取的已校验归档提取固定运行包，窗口退出后删除临时文件。 */
export async function runSceneClientNative({ archivePath, nativeExecutable, verifyWindow = false }, { spawnProcess = spawn } = {}) {
  if (!archivePath || !nativeExecutable) throw new Error("必须提供客户端包和 --native-executable 路径");
  if (typeof verifyWindow !== "boolean") throw new Error("窗口检查选项无效");
  const executable = path.resolve(nativeExecutable);
  if (!(await stat(executable)).isFile()) throw new Error("Native 可执行文件不是文件");
  const chunks = []; let length = 0;
  for await (const chunk of createReadStream(archivePath)) {
    length += chunk.length;
    if (length > sceneClientArchiveLimits.archiveBytes) throw new Error("客户端 ZIP 超过读取限额");
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks, length);
  const { manifest } = await verifySceneClientArchive(buffer, { expectedTarget: "deep-native" });
  const runtimePath = "native/runtime-package.json";
  const expected = manifest.files.find(file => file.path === runtimePath);
  const zip = await yauzl.fromBufferPromise(buffer, { strictFileNames: true, validateEntrySizes: true, autoClose: false });
  let runtime;
  try {
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName !== runtimePath) continue;
      const stream = await zip.openReadStreamPromise(entry); const chunks = []; let bytes = 0;
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > expected.bytes) { stream.destroy(); throw new Error("Native 运行包大小不一致"); }
        chunks.push(chunk);
      }
      runtime = Buffer.concat(chunks, bytes);
      if (bytes !== expected.bytes || createHash("sha256").update(runtime).digest("hex") !== expected.sha256) throw new Error("Native 运行包内容不一致");
    }
  } finally { zip.close(); }
  if (!runtime) throw new Error("缺少 Native 运行包");
  const directory = await mkdtemp(path.join(tmpdir(), "deep-scene-client-"));
  try {
    const packagePath = path.join(directory, "runtime-package.json");
    await writeFile(packagePath, runtime, { flag: "wx", mode: 0o600 });
    if (verifyWindow) return await verifySceneNativeWindow({ packagePath, nativeExecutable: executable, frames: 3 }, { spawnProcess });
    return await new Promise((resolve, reject) => {
      const child = spawnProcess(executable, ["--package", packagePath], { cwd: directory, shell: false, stdio: "inherit" });
      // error 后也等 close，避免已启动进程仍访问临时文件时提前清理。
      let error;
      child.once("error", reason => { error = reason; });
      child.once("close", (code, signal) => {
        if (error) reject(error);
        else if (code !== 0) reject(new Error(`Native 客户端退出：${signal ?? code}`));
        else resolve({ status: "closed", code: 0 });
      });
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function parseNativeClientArguments(args) {
  const [archivePath, flag, nativeExecutable, ...rest] = args;
  if (!archivePath || !nativeExecutable || flag !== "--native-executable"
    || !(rest.length === 0 || (rest.length === 1 && rest[0] === "--verify-window"))) {
    throw new Error("用法：node scripts/run-scene-client-native.mjs <包.bimscene.zip> --native-executable <Native程序路径> [--verify-window]");
  }
  return { archivePath, nativeExecutable, verifyWindow: rest.length === 1 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseNativeClientArguments(process.argv.slice(2));
    const result = await runSceneClientNative(options);
    if (options.verifyWindow) console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
