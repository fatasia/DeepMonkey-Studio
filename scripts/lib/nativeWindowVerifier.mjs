import { createReadStream } from "node:fs";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const check = (value, message) => { if (!value) throw new Error(`Native 窗口验证失败：${message}`); };

/**
 * 一个本机验证记录；不构成远程授权或正式发布状态。
 * verifyCommand 把 scene 与 dashboard 两条验证链物理分开：scene 发布候选走
 * `--verify-package`，dashboard 内容包（.dmda 正式链）走 `--verify-dashboard-package`，
 * 两者互不串链；不支持该命令的旧 native 程序在进程层失败 → 调用方 fail-closed。
 */
function createProcessWindowVerifier(parseDeepRuntimePackage, verifyCommand) {
return async function verifyNativeWindow({ packagePath, nativeExecutable, frames = 3, signal }, { spawnProcess = spawn, timeoutMs = 60_000 } = {}) {
  signal?.throwIfAborted();
  check(packagePath && nativeExecutable, "缺少运行包或可执行文件路径");
  check(Number.isSafeInteger(frames) && frames >= 1 && frames <= 120, "frames 必须为 1..120");
  check(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000, "超时限额无效");
  const executable = path.resolve(nativeExecutable);
  check((await stat(executable)).isFile(), "可执行程序不是文件");
  const executableBytes = await boundedRead(executable, 512 * 1024 ** 2, signal);
  const executableSha256 = hash(executableBytes);
  const bytes = await boundedRead(packagePath, 256 * 1024 ** 2, signal);
  const parsed = parseDeepRuntimePackage(bytes);
  check(parsed.valid, `运行包无效：${parsed.valid ? "" : parsed.issues[0]?.message}`);
  const sourceSha256 = hash(bytes), packageHash = parsed.value.packageHash;
  const nonce = randomUUID(), directory = await mkdtemp(path.join(tmpdir(), "deep-native-window-"));
  try {
    const privateExecutable = path.join(directory, "native-client.exe");
    const candidate = path.join(directory, "runtime-package.json"), reportPath = path.join(directory, "report.json");
    await writeFile(candidate, bytes, { flag: "wx", mode: 0o400 });
    await writeFile(privateExecutable, executableBytes, { flag: "wx", mode: 0o500 });
    check(hash(await readFile(privateExecutable)) === executableSha256, "可执行程序副本校验失败");
    check(hash(await readFile(candidate)) === sourceSha256, "候选运行包在启动前发生变化");
    await runProcess(spawnProcess, privateExecutable, [verifyCommand, candidate, "--report", reportPath, "--nonce", nonce, "--frames", String(frames)], directory, timeoutMs, signal);
    check(hash(await readFile(candidate)) === sourceSha256, "候选运行包在验证期间发生变化");
    check(hash(await boundedRead(privateExecutable, 512 * 1024 ** 2, signal)) === executableSha256, "可执行程序在验证期间发生变化");
    signal?.throwIfAborted();
    const report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedRead(reportPath, 64 * 1024, signal)));
    check(report?.schemaVersion === 1 && report.scope === "native-window", "报告版本或范围不匹配");
    check(report.nonce === nonce, "报告任务标识不匹配");
    check(report.packageHash === packageHash.value, "报告运行包 hash 不匹配");
    check(Number.isSafeInteger(report.width) && report.width >= 480 && Number.isSafeInteger(report.height) && report.height >= 320, "报告窗口尺寸不匹配");
    check(Number.isSafeInteger(report.presentedFrames) && report.presentedFrames >= frames && report.presentedFrames <= 120, "实际呈现帧不足或无效");
    check(typeof report.backend === "string" && report.backend.trim().length > 0 && report.gpuErrorsClean === true, "GPU 检查未通过");
    return { schemaVersion: 1, scope: "native-window", sourceSha256, executable, executableSha256,
      packageHash, nonce, requestedFrames: frames, report, verifiedAt: new Date().toISOString() };
  } finally { await rm(directory, { recursive: true, force: true }); }
};
}

/** scene 发布候选的窗口验证（`--verify-package`）。 */
export function createNativeWindowVerifier(parseDeepRuntimePackage) {
  return createProcessWindowVerifier(parseDeepRuntimePackage, "--verify-package");
}

/** dashboard 内容包的窗口验证（.dmda 正式链的 `--verify-dashboard-package`）。 */
export function createDashboardNativeProcessVerifier(parseDeepRuntimePackage) {
  return createProcessWindowVerifier(parseDeepRuntimePackage, "--verify-dashboard-package");
}

async function boundedRead(file, maxBytes, signal) {
  const chunks = []; let bytes = 0;
  for await (const chunk of createReadStream(file, { signal })) {
    bytes += chunk.length; check(bytes <= maxBytes, "文件超过读取限额"); chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

async function runProcess(spawnProcess, privateExecutable, args, cwd, timeoutMs, abortSignal) {
  abortSignal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const child = spawnProcess(privateExecutable, args, { cwd, shell: false, stdio: "inherit" });
    let error, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    const abort = () => { error = abortSignal.reason instanceof Error ? abortSignal.reason : new Error("Native 窗口验证已取消"); child.kill(); };
    abortSignal?.addEventListener("abort", abort, { once: true });
    if (abortSignal?.aborted) abort();
    child.once("error", reason => { error = reason; });
    child.once("close", (code, signal) => {
      clearTimeout(timer); abortSignal?.removeEventListener("abort", abort);
      if (timedOut) reject(new Error("Native 窗口验证超时"));
      else if (error) reject(error);
      else if (code !== 0) reject(new Error(`Native 窗口提前退出：${signal ?? code}`));
      else resolve();
    });
  });
}
