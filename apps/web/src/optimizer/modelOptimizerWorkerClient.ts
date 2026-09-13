import type { ModelFileStatistics, ModelOptimizationOptions, ModelOptimizationResult } from "./modelOptimizer";
import type { OptimizerLayerEdit, OptimizerLayerResult } from "./optimizerLayers";
import type { ModelOptimizerWorkerRequest, ModelOptimizerWorkerResponse } from "./modelOptimizerWorkerProtocol";
import type { OptimizerLayerDraft } from "./optimizerLayerSession";

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  onProgress?: ((message: string) => void) | undefined;
}

export class ModelOptimizerWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest<unknown>>();
  private nextId = 1;
  private closed = false;
  private closedReason: unknown;
  private cachedFile: File | undefined;
  private cacheKey = 0;

  constructor() {
    this.worker = new Worker(new URL("./modelOptimizer.worker.ts", import.meta.url), { type: "module", name: "bim-studio-model-optimizer" });
    this.worker.onmessage = (event: MessageEvent<ModelOptimizerWorkerResponse>) => this.handleMessage(event.data);
    this.worker.onerror = (event) => this.terminate(new Error(event.message || "模型优化 Worker 运行失败"));
    this.worker.onmessageerror = () => this.terminate(new Error("模型优化 Worker 返回了无法解析的数据"));
  }

  async inspect(file: File): Promise<ModelFileStatistics> {
    this.cachedFile = undefined;
    const buffer = await file.arrayBuffer();
    return await this.request<ModelFileStatistics>({ id: this.nextId++, action: "inspect", name: file.name, buffer }, [buffer]);
  }

  async layers(file:File,edits:OptimizerLayerEdit[]):Promise<OptimizerLayerResult>{
    this.cachedFile = undefined;
    const buffer=await file.arrayBuffer();
    return this.request<OptimizerLayerResult>({id:this.nextId++,action:"layers",name:file.name,buffer,edits},[buffer]);
  }

  async layerDraft(file: File, edits: OptimizerLayerEdit[]): Promise<OptimizerLayerDraft> {
    return this.cachedLayers(file, edits, "layers-draft");
  }

  async materializeLayers(file: File, edits: OptimizerLayerEdit[]): Promise<OptimizerLayerResult> {
    return this.cachedLayers(file, edits, "layers-materialize");
  }

  private async cachedLayers<T>(file: File, edits: OptimizerLayerEdit[], action: "layers-draft" | "layers-materialize"): Promise<T> {
    const fresh = this.cachedFile !== file;
    const buffer = fresh ? await file.arrayBuffer() : undefined;
    if (fresh) this.cacheKey += 1;
    const result = await this.request<T>({ id: this.nextId++, action, key: String(this.cacheKey), name: file.name, edits, ...(buffer ? { buffer } : {}) }, buffer ? [buffer] : []);
    this.cachedFile = file;
    return result;
  }

  async optimize(file: File, options: ModelOptimizationOptions, onProgress?: (message: string) => void, copyright?: string): Promise<ModelOptimizationResult> {
    this.cachedFile = undefined;
    const buffer = await file.arrayBuffer();
    return await this.request<ModelOptimizationResult>({ id: this.nextId++, action: "optimize", name: file.name, buffer, options, ...(copyright ? { copyright } : {}) }, [buffer], onProgress);
  }

  terminate(reason: unknown = new DOMException("模型处理已取消", "AbortError")) {
    if (this.closed) return;
    this.closed = true;
    this.cachedFile = undefined;
    this.closedReason = reason;
    this.worker.terminate();
    this.failAll(reason);
  }

  private request<T>(message: ModelOptimizerWorkerRequest, transfer: Transferable[], onProgress?: (message: string) => void): Promise<T> {
    if (this.closed) return Promise.reject(this.closedReason);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(message.id, { resolve: resolve as (value: unknown) => void, reject, onProgress });
      try { this.worker.postMessage(message, transfer); }
      catch (reason) { this.terminate(reason); }
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
