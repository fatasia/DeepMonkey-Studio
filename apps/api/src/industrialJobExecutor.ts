import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface IndustrialJobRequest {
  executable: string;
  arguments: string[];
  payload: unknown;
  limits: { timeoutMs: number; maxMemoryMb: number; maxCpuPercent: number };
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  registerResourceExit?: ((exit: Promise<void>) => void) | undefined;
  maxOutputBytes?: number;
  label?: string;
}

/** 共用既有 Windows Job 宿主；只有进程树退出后才交还产物发布权。 */
export function runIndustrialJob(request: IndustrialJobRequest): Promise<unknown> {
  request.signal?.throwIfAborted();
  const host = fileURLToPath(new URL("../dist/industrial-worker/industrial-worker-host.exe", import.meta.url));
  const label = request.label ?? "工业格式";
  const budget = request.maxOutputBytes ?? 16_384;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 1024 * 1024) throw new Error("工业 Worker 回执预算无效");
  // 运行时可能传入完整 ConverterPluginManifest.limits；宿主严格拒绝额外字段。
  const payload = JSON.stringify({ parentPid: process.pid, executable: request.executable, arguments: request.arguments,
    payload: request.payload, maxMemoryMb: request.limits.maxMemoryMb, maxCpuPercent: request.limits.maxCpuPercent,
    timeoutMs: request.timeoutMs ?? request.limits.timeoutMs });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP)$/i.test(key)));
  const child = spawn(host, [], { windowsHide: true, env, stdio: ["pipe", "pipe", "pipe"] });
  let resolveExit!: () => void;
  const exited = new Promise<void>(resolve => { resolveExit = resolve; });
  request.registerResourceExit?.(exited);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let outputBytes = 0, errorText = "", failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error; child.stdin.end("cancel\n");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
    };
    const abort = () => stop(new Error(`${label}转换已取消（Windows Job）`));
    const timer = setTimeout(() => stop(new Error(`${label} worker 运行超时（Windows Job）`)), request.timeoutMs ?? request.limits.timeoutMs);
    request.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", error => { failure = new Error(`${label} Windows Job 宿主不可用：${error.message}`); });
    child.stdin.on("error", error => { failure ??= error; });
    child.stdout.on("data", (bytes: Buffer) => {
      outputBytes += bytes.length;
      if (outputBytes > budget) stop(new Error(`${label} worker 回执超限`));
      else chunks.push(bytes);
    });
    child.stderr.on("data", bytes => { errorText = (errorText + String(bytes)).slice(-2000); });
    child.once("close", code => {
      clearTimeout(timer);if (killTimer) clearTimeout(killTimer);
      request.signal?.removeEventListener("abort", abort);resolveExit();
      if (failure) { reject(failure);return; }
      if (code !== 0) { reject(new Error(`${label} Windows Job 执行失败：${errorText.trim() || code}`));return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error(`${label} worker 回执不是有效 JSON`)); }
    });
    if (request.signal?.aborted) abort();
    else child.stdin.write(payload + "\n");
  });
}
