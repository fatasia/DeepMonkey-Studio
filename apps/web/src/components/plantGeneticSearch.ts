import type { GeneticOptimizationResult } from "@bim-studio/contracts";
import type { PlantLiteModel } from "@bim-studio/contracts";

export interface PlantGeneticSearchInput {
  model: PlantLiteModel;
  stationId: string;
  minimumMinutes: number;
  maximumMinutes: number;
  seed: string | number;
}

type WorkerReply = { ok: true; result: GeneticOptimizationResult } | { ok: false; message: string };

/** Bounded eight-evaluation GA screening runs off the UI thread; cancel/timeout terminate the worker. */
export function searchPlantGeneticCandidate(input: PlantGeneticSearchInput, signal?: AbortSignal): Promise<GeneticOptimizationResult> {
  if (signal?.aborted) return Promise.reject(new DOMException("优化已取消", "AbortError"));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./plantGeneticOptimization.worker.ts", import.meta.url), { type: "module", name: "plant-ga-screening" });
    let settled = false;
    const finish = (done: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      done();
    };
    const abort = () => finish(() => reject(new DOMException("优化已取消", "AbortError")));
    const timeout = setTimeout(() => finish(() => reject(new Error("GA 筛查超时 15 秒；请降低模型规模后重试。"))), 15_000);
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      if (reply.ok === true) finish(() => resolve(reply.result));
      else finish(() => reject(new Error(reply.message)));
    };
    worker.onerror = () => finish(() => reject(new Error("GA 筛查线程异常；请重试或检查工位模型。")));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else worker.postMessage(input);
  });
}
