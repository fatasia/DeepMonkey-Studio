import type { GltfDecodedImage, GltfEncodedImage, GltfImageDecoder } from "@bim-studio/deep-engine/gltf";

export interface CappedImageDecoder extends GltfImageDecoder {
  decodeCapped?(image: GltfEncodedImage, cap: number, signal?: AbortSignal): Promise<GltfDecodedImage>;
}
interface ImageWorkerReply { id: number; image?: GltfDecodedImage; error?: string }
interface ImageJob { resolve(image: GltfDecodedImage): void; reject(reason: unknown): void; cleanup(): void }
export interface ImageWorkerHost {
  onmessage: ((event: { data: ImageWorkerReply }) => void) | null;
  onerror: ((event: { preventDefault(): void; message: string }) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  terminate(): void;
}

/** One lazy image worker; encoded slices remain owned by the packet compiler. */
export function createImageWorkerDecoder(createWorker: () => ImageWorkerHost): CappedImageDecoder {
  let worker: ImageWorkerHost | undefined, nextId = 0;
  const jobs = new Map<number, ImageJob>();
  function fail(reason: unknown) {
    worker?.terminate(); worker = undefined;
    for (const job of jobs.values()) { job.cleanup(); job.reject(reason); }
    jobs.clear();
  }
  function instance() {
    if (!worker) {
      worker = createWorker();
      worker.onmessage = (event) => {
        const reply = event.data, job = jobs.get(reply.id);
        if (!job) return;
        jobs.delete(reply.id); job.cleanup();
        if (reply.image) job.resolve(reply.image);
        else job.reject(new Error(reply.error ?? "纹理 Worker 未返回像素。"));
      };
      worker.onerror = (event) => { event.preventDefault(); fail(new Error(event.message || "纹理 Worker 启动失败。")); };
      worker.onmessageerror = () => fail(new Error("纹理 Worker 数据传输失败。"));
    }
    return worker;
  }
  function decode(image: GltfEncodedImage, signal?: AbortSignal, cap?: number): Promise<GltfDecodedImage> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const abort = () => {
        const job = jobs.get(id);
        if (!job) return;
        jobs.delete(id); job.cleanup();
        worker?.postMessage({ id, cancel: true });
        if (!jobs.size) { worker?.terminate(); worker = undefined; }
        reject(signal?.reason);
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      try {
        const target = instance();
        jobs.set(id, { resolve, reject, cleanup }); signal?.addEventListener("abort", abort, { once: true });
        const data = image.data.slice();
        target.postMessage({ id, image: { ...image, data }, ...(cap === undefined ? {} : { cap }) }, [data.buffer]);
      } catch (reason) { jobs.delete(id); cleanup(); reject(reason); }
    });
  }
  return { decode: (image, signal) => decode(image, signal), decodeCapped: (image, cap, signal) => decode(image, signal, cap) };
}
