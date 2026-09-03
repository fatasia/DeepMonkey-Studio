import { Worker } from "node:worker_threads";
import type { PlantLiteStudyRecord, PlantLiteStudyRequest } from "@bim-studio/contracts";

export class PlantLiteWorkerExecutionError extends Error {}
export class PlantLiteWorkerTimeoutError extends PlantLiteWorkerExecutionError {}
export class PlantLiteWorkerCancelledError extends PlantLiteWorkerExecutionError {}

export interface PlantLiteStudyExecutor {
  run(projectId: string, request: PlantLiteStudyRequest, signal?: AbortSignal): Promise<PlantLiteStudyRecord>;
}

export interface PlantLiteWorkerExecutorOptions {
  timeoutMs?: number;
  createWorker?: () => Worker;
}

/** API 请求线程只负责编排、超时和持久化；多重复 DES 始终在独立 Worker 中运行。 */
export class PlantLiteWorkerExecutor implements PlantLiteStudyExecutor {
  private readonly timeoutMs: number;
  private readonly createWorker: () => Worker;

  public constructor(options: PlantLiteWorkerExecutorOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.createWorker = options.createWorker ?? createPlantLiteWorker;
  }

  public run(projectId: string, request: PlantLiteStudyRequest, signal?: AbortSignal): Promise<PlantLiteStudyRecord> {
    if (signal?.aborted) return Promise.reject(new PlantLiteWorkerCancelledError("Plant Lite Study 已取消"));
    return new Promise((resolve, reject) => {
      const worker = this.createWorker();
      let settled = false;
      const close = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        worker.removeAllListeners();
      };
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        close();
        void worker.terminate();
        action();
      };
      const abort = () => finish(() => reject(new PlantLiteWorkerCancelledError("Plant Lite Study 已取消")));
      const timeout = setTimeout(() => finish(() => reject(new PlantLiteWorkerTimeoutError(`Plant Lite Study 超时（${this.timeoutMs}ms）`))), this.timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      worker.once("error", (error) => finish(() => reject(new PlantLiteWorkerExecutionError(compactError(error)))));
      worker.once("exit", (code) => {
        if (code !== 0) finish(() => reject(new PlantLiteWorkerExecutionError(`Plant Lite Worker 意外退出（${code}）`)));
      });
      worker.on("message", (message: unknown) => {
        // `node --watch` forwards dependency notifications from a TypeScript Worker over
        // the same message channel before the application result. They are not part of
        // the Plant Lite protocol and must not settle the simulation request.
        if (isNodeWatchControlMessage(message)) return;
        const decoded = decodeWorkerMessage(message);
        if (!decoded.ok) {
          const protocolError = decoded.message;
          finish(() => reject(new PlantLiteWorkerExecutionError(protocolError)));
          return;
        }
        const value = decoded.value;
        if (value.type === "error") {
          const workerError = value.message;
          finish(() => reject(new PlantLiteWorkerExecutionError(workerError)));
          return;
        }
        const record = value.record;
        finish(() => resolve(record));
      });
      worker.postMessage({ projectId, request });
    });
  }
}

export function isNodeWatchControlMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const fields = Object.keys(message);
  return fields.length === 1 && (fields[0] === "watch:import" || fields[0] === "watch:require");
}

type WorkerMessage =
  | { type: "result"; record: PlantLiteStudyRecord }
  | { type: "error"; message: string };

export function decodeWorkerMessage(message: unknown):
  | { ok: true; value: WorkerMessage }
  | { ok: false; message: string } {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { ok: false, message: `Plant Lite Worker 协议无效（收到 ${typeof message}）` };
  }
  const value = message as Record<string, unknown>;
  if (value.type === "error" && typeof value.message === "string") {
    return { ok: true, value: { type: "error", message: compactError(value.message) } };
  }
  if (value.type === "result" && value.record && typeof value.record === "object" && !Array.isArray(value.record)) {
    return { ok: true, value: { type: "result", record: value.record as PlantLiteStudyRecord } };
  }
  const fields = Object.keys(value).sort().slice(0, 12).join(", ") || "无字段";
  return { ok: false, message: `Plant Lite Worker 协议无效（type=${String(value.type ?? "缺失")}；字段：${fields}）` };
}

function createPlantLiteWorker(): Worker {
  if (import.meta.url.endsWith(".ts")) {
    // The API development process resolves workspace packages from source. The Worker must
    // inherit that condition as well; otherwise it silently loads stale dist exports.
    return new Worker(new URL("./plantLiteWorker.ts", import.meta.url), {
      execArgv: ["--conditions=development", "--import", "tsx"],
    });
  }
  return new Worker(new URL("./plantLiteWorker.js", import.meta.url));
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 300) || "Plant Lite Worker 失败";
}
