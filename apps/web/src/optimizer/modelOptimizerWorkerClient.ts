import type { ModelFileStatistics, ModelOptimizationOptions, ModelOptimizationResult } from "./modelOptimizer";
import type { ModelOptimizerWorkerRequest, ModelOptimizerWorkerResponse } from "./modelOptimizerWorkerProtocol";

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  onProgress?: ((message: string) => void) | undefined;
}

export class ModelOptimizerWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest<unknown>>();
  private nextId = 1;

  constructor() {
    this.worker = new Worker(new URL("./modelOptimizer.worker.ts", import.meta.url), { type: "module", name: "bim-studio-model-optimizer" });
    this.worker.onmessage = (event: MessageEvent<ModelOptimizerWorkerResponse>) => this.handleMessage(event.data);
    this.worker.onerror = (event) => this.failAll(new Error(event.message || "模型优化 Worker 运行失败"));
    this.worker.onmessageerror = () => this.failAll(new Error("模型优化 Worker 返回了无法解析的数据"));
  }

  async inspect(file: File): Promise<ModelFileStatistics> {
    const buffer = await file.arrayBuffer();
    return await this.request<ModelFileStatistics>({ id: this.nextId++, action: "inspect", name: file.name, buffer }, [buffer]);
  }

  async optimize(file: File, options: ModelOptimizationOptions, onProgress?: (message: string) => void): Promise<ModelOptimizationResult> {
    const buffer = await file.arrayBuffer();
    return await this.request<ModelOptimizationResult>({ id: this.nextId++, action: "optimize", name: file.name, buffer, options }, [buffer], onProgress);
  }

  terminate(reason: unknown = new DOMException("模型处理已取消", "AbortError")) {
    this.worker.terminate();
    this.failAll(reason);
  }

  private request<T>(message: ModelOptimizerWorkerRequest, transfer: Transferable[], onProgress?: (message: string) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(message.id, { resolve: resolve as (value: unknown) => void, reject, onProgress });
      this.worker.postMessage(message, transfer);
    });
  }

  private handleMessage(message: ModelOptimizerWorkerResponse) {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === "progress") {
      pending.onProgress?.(message.message);
      return;
    }
    this.pending.delete(message.id);
    if (message.type === "error") pending.reject(Object.assign(new Error(message.message), { stack: message.stack }));
    else pending.resolve(message.result);
  }

  private failAll(reason: unknown) {
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
  }
}
