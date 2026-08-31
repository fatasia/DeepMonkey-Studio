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
      worker.once("message", (message: WorkerMessage) => {
        if (message.type === "error") finish(() => reject(new PlantLiteWorkerExecutionError(message.message)));
        else finish(() => resolve(message.record));
      });
      worker.postMessage({ projectId, request });
    });
  }
}

type WorkerMessage =
  | { type: "result"; record: PlantLiteStudyRecord }
  | { type: "error"; message: string };

function createPlantLiteWorker(): Worker {
  if (import.meta.url.endsWith(".ts")) {
    return new Worker(new URL("./plantLiteWorker.ts", import.meta.url), { execArgv: ["--import", "tsx"] });
  }
  return new Worker(new URL("./plantLiteWorker.js", import.meta.url));
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 300) || "Plant Lite Worker 失败";
}
