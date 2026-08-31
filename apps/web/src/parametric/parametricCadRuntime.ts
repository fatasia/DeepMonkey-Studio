import type { ParametricCadDefinition } from "@bim-studio/contracts";
import { assertParametricCadDefinition } from "@bim-studio/parametric-modeling-plugin";
import type { ParametricCadBuildResult, ParametricCadWorkerResponse } from "./parametricCadTypes";

export interface ParametricBuildOptions { timeoutMs?: number; signal?: AbortSignal; }

/**
 * 每次构建使用独立 Worker。参数化建模是低频任务，进程隔离比复用 WASM 堆更重要：
 * 成功、失败、取消和超时都会释放完整 OpenCascade 内存，不影响三维主线程。
 */
export function buildParametricCad(input: ParametricCadDefinition, options: ParametricBuildOptions = {}): Promise<ParametricCadBuildResult> {
  const definition = assertParametricCadDefinition(input);
  const timeoutMs = Math.max(1_000, Math.min(120_000, options.timeoutMs ?? 30_000));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./parametricCad.worker.ts", import.meta.url), { type: "module", name: "bim-parametric-cad" });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      worker.terminate();
      callback();
    };
    const abort = () => finish(() => reject(new DOMException("参数化模型构建已取消", "AbortError")));
    const timer = window.setTimeout(() => finish(() => reject(new Error(`参数化模型构建超过 ${Math.round(timeoutMs / 1_000)} 秒，已终止隔离 Worker`))), timeoutMs);
    worker.onmessage = (event: MessageEvent<ParametricCadWorkerResponse>) => {
      if (event.data.id !== id) return;
      if (event.data.ok && event.data.result) finish(() => resolve(event.data.result!));
      else finish(() => reject(new Error(event.data.error || "参数化模型构建失败")));
    };
    worker.onerror = (event) => finish(() => reject(new Error(event.message || "参数化建模 Worker 异常")));
    if (options.signal?.aborted) abort();
    else {
      options.signal?.addEventListener("abort", abort, { once: true });
      worker.postMessage({ id, definition: structuredClone(definition) });
    }
  });
}
