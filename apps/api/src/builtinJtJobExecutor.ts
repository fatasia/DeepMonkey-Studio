import { fileURLToPath } from "node:url";
import type { BuiltinJtWorkerOptions } from "./builtinJtWorkerExecutor.js";
import { isBuiltinJtResult, type BuiltinJtRequest, type BuiltinJtResult } from "./builtinJtWorkerProtocol.js";
import { runIndustrialJob } from "./industrialJobExecutor.js";

export async function runBuiltinJtJob(request: BuiltinJtRequest, options: BuiltinJtWorkerOptions): Promise<BuiltinJtResult> {
  const development = import.meta.url.endsWith(".ts");
  const worker = fileURLToPath(new URL(development ? "./builtinJtWorker.ts" : "./builtinJtWorker.js", import.meta.url));
  const message = await runIndustrialJob({
    executable: process.execPath,
    arguments: [...(development ? ["--conditions=development", "--import", "tsx"] : []), "--max-old-space-size=1024", worker],
    payload: request,
    limits: options.limits ?? { timeoutMs: 1_800_000, maxMemoryMb: 16384, maxCpuPercent: 100 },
    timeoutMs: options.timeoutMs, signal: options.signal, registerResourceExit: options.registerResourceExit, label: "JT",
  }) as { type?: string; value?: unknown };
  if (message?.type !== "result" || !isBuiltinJtResult(message.value)) throw new Error("JT worker 协议无效");
  return message.value;
}
