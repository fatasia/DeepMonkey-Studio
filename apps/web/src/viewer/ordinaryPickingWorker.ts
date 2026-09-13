import type { SerializedBVH } from "three-mesh-bvh";
import type { PickingBuilder, PickingSnapshot } from "./ordinaryPickingGeometry";

export class PickingWorker implements PickingBuilder {
  private worker: Worker | undefined;
  private cancel: (() => void) | undefined;

  build(snapshot: PickingSnapshot, signal: AbortSignal): Promise<SerializedBVH> {
    return new Promise((resolve, reject) => {
      if (signal.aborted || typeof Worker === "undefined") { reject(new Error("Picking worker unavailable")); return; }
      this.worker ??= new Worker(new URL("./ordinaryPicking.worker.ts", import.meta.url), { type: "module" });
      const worker = this.worker;
      const finish = (error?: Error, serialized?: SerializedBVH) => {
        clearTimeout(timeout); signal.removeEventListener("abort", cancel);
        this.cancel = undefined; worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
        if (error) { worker.terminate(); if (this.worker === worker) this.worker = undefined; reject(error); }
        else if (serialized) resolve(serialized);
      };
      const cancel = () => finish(new DOMException("Picking index cancelled", "AbortError"));
      const timeout = setTimeout(() => finish(new Error("Picking index timed out")), 30000);
      this.cancel = cancel; signal.addEventListener("abort", cancel, { once: true });
      worker.onerror = () => finish(new Error("Picking worker failed"));
      worker.onmessageerror = () => finish(new Error("Picking worker response failed"));
      worker.onmessage = (event: MessageEvent<{ serialized?: SerializedBVH; error?: string }>) => {
        if (event.data.serialized?.roots?.length && event.data.serialized.indirectBuffer) finish(undefined, event.data.serialized);
        else finish(new Error("Picking worker response invalid"));
      };
      const transfer: Transferable[] = [snapshot.position.buffer as ArrayBuffer];
      if (snapshot.index) transfer.push(snapshot.index.buffer as ArrayBuffer);
      try { worker.postMessage(snapshot, transfer); } catch { finish(new Error("Picking worker transfer failed")); }
    });
  }

  dispose(): void { this.cancel?.(); this.worker?.terminate(); this.worker = undefined; }
}
