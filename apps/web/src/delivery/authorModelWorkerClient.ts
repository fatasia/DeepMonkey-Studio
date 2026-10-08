import { GltfImportError } from "@bim-studio/deep-engine/gltf";
import type { AuthorModelDecoder, AuthorModelDecodeOptions, AuthorModelDecodeResult } from "./authorModelDecode";
import { copyAuthorModelBytes } from "./authorModelTransfer";
import { markAuthorModelNormalizationFailure } from "./authorModelDecode";

export interface AuthorModelFailure {
  readonly message: string;
  readonly normalization?: boolean;
  readonly gltf?: { readonly code: "invalid" | "unsupported" | "limit"; readonly path: string; readonly feature?: string };
}
export interface AuthorModelWorkerReply { readonly id: number; readonly result?: AuthorModelDecodeResult; readonly error?: AuthorModelFailure }
export interface AuthorModelWorkerRequest { readonly id: number; readonly bytes: Uint8Array; readonly options: AuthorModelDecodeOptions }
export interface AuthorModelWorkerHost {
  onmessage: ((event: { data: AuthorModelWorkerReply }) => void) | null;
  onerror: ((event: { message: string; preventDefault(): void }) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage(request: AuthorModelWorkerRequest, transfer: ArrayBuffer[]): void;
  terminate(): void;
}
interface Job { resolve(result: AuthorModelDecodeResult): void; reject(reason: unknown): void; cleanup(): void }

export function createAuthorModelWorkerDecoder(factory: () => AuthorModelWorkerHost): AuthorModelDecoder {
  let worker: AuthorModelWorkerHost | undefined, nextId = 0;
  const jobs = new Map<number, Job>();
  function fail(reason: unknown) {
    worker?.terminate(); worker = undefined;
    for (const job of jobs.values()) { job.cleanup(); job.reject(reason); }
    jobs.clear();
  }
  function instance() {
    if (!worker) {
      worker = factory();
      worker.onmessage = ({ data }) => {
        const job = jobs.get(data.id);
        if (!job) return;
        jobs.delete(data.id); job.cleanup();
        if (data.result) { job.resolve(data.result); return; }
        const error = data.error;
        if (error?.gltf) {
          const rebuilt = new GltfImportError(error.gltf.code, error.gltf.path, "", error.gltf.feature);
          rebuilt.message = error.message;
          if (error.normalization) markAuthorModelNormalizationFailure(rebuilt);
          job.reject(rebuilt);
        } else job.reject(new Error(error?.message ?? "模型 Worker 未返回资源。"));
      };
      worker.onerror = event => { event.preventDefault(); fail(new Error(event.message || "模型 Worker 启动失败。")); };
      worker.onmessageerror = () => fail(new Error("模型 Worker 数据传输失败。"));
    }
    return worker;
  }
  return async (source, options, signal) => {
    const bytes = await copyAuthorModelBytes(source, signal);
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const abort = () => {
        const job = jobs.get(id);
        if (!job) return;
        jobs.delete(id); job.cleanup(); reject(signal.reason);
        // Scene compilation is serial per asset; retain concurrent jobs if another caller shares it.
        if (!jobs.size) { worker?.terminate(); worker = undefined; }
      };
      const cleanup = () => signal.removeEventListener("abort", abort);
      try {
        signal.throwIfAborted();
        const target = instance(); jobs.set(id, { resolve, reject, cleanup });
        signal.addEventListener("abort", abort, { once: true });
        target.postMessage({ id, bytes, options }, [bytes.buffer]);
      } catch (error) { jobs.delete(id); cleanup(); reject(error); }
    });
  };
}
