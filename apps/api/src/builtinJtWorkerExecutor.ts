import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isBuiltinJtResult, type BuiltinJtRequest, type BuiltinJtResult } from "./builtinJtWorkerProtocol.js";
import { runBuiltinJtJob } from "./builtinJtJobExecutor.js";

export interface BuiltinJtWorkerOptions {
  signal?: AbortSignal | undefined;
  registerResourceExit?: ((exit: Promise<void>) => void) | undefined;
  createChild?: () => ChildProcess;
  timeoutMs?: number;
  limits?: { timeoutMs: number; maxMemoryMb: number; maxCpuPercent: number } | undefined;
}

/** 独立进程执行同步 reader；只有收到 close 后才交还父进程发布权。 */
export function runBuiltinJtWorker(request: BuiltinJtRequest, options: BuiltinJtWorkerOptions = {}): Promise<BuiltinJtResult> {
  options.signal?.throwIfAborted();
  if (process.platform === "win32" && !options.createChild) return runBuiltinJtJob(request, options);
  const child = (options.createChild ?? createChild)();
  let resolveExit!: () => void;
  const exited = new Promise<void>(resolve => { resolveExit = resolve; });
  options.registerResourceExit?.(exited);
  return new Promise((resolve, reject) => {
    let result: BuiltinJtResult | undefined;
    let failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      // SIGKILL 在 Windows 映射为强制终止；不等同于仅断开 IPC。
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const abort = () => stop(new Error("JT 转换已取消"));
    const timer = setTimeout(() => stop(new Error("JT worker 运行超时")), options.timeoutMs ?? 300_000);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", error => { stop(error); });
    child.on("message", (message: unknown) => {
      const value = message as { type?: string; value?: unknown; message?: unknown } | null;
      if (value?.type === "result" && isBuiltinJtResult(value.value) && !result) result = value.value;
      else stop(new Error(value?.type === "error" && typeof value.message === "string" ? value.message.slice(0, 500) : "JT worker 协议无效"));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolveExit();
      if (failure) reject(failure);
      else if (code !== 0 || signal || !result) reject(new Error(`JT worker 异常退出（${code ?? signal}）`));
      else resolve(result);
    });
    if (options.signal?.aborted) abort();
    else child.send(request, error => { if (error) stop(error); });
  });
}

function createChild(): ChildProcess {
  const development = import.meta.url.endsWith(".ts");
  // 不向无数据库职责的解析进程继承凭据或 NODE_OPTIONS 注入。
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP)$/i.test(key)));
  const options: ForkOptions & { windowsHide: boolean } = {
    windowsHide: true, env, stdio: ["ignore", "ignore", "ignore", "ipc"],
    execArgv: [...(development ? ["--conditions=development", "--import", "tsx"] : []), "--max-old-space-size=1024"],
  };
  return fork(fileURLToPath(new URL(development ? "./builtinJtWorker.ts" : "./builtinJtWorker.js", import.meta.url)), [], options);
}
