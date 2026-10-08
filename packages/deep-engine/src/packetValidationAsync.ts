import { validateRenderPacket, type RenderPacket } from "./renderPacket.js";
import type { MaterialInstanceOptions } from "./materialInstanceAbi.js";
import { assertPacketCloneSafe } from "./packetPreparationWork.js";
import { packetPreparationIsLarge } from "./packetPreparationAsync.js";

export interface PacketValidationWorker {
  onmessage: ((event: { data: { validated?: boolean; error?: string } }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  postMessage(value: unknown): void;
  terminate(): void;
}
declare const Worker: new (url: URL, options: { type: "module" }) => PacketValidationWorker;

/** Compiler admission only. Upload preparation retains its separate owned snapshots. */
export async function validateRenderPacketAsync(packet: RenderPacket, options: MaterialInstanceOptions = {},
  signal?: AbortSignal, createWorker?: () => PacketValidationWorker): Promise<void> {
  signal?.throwIfAborted();
  assertPacketCloneSafe(packet); assertPacketCloneSafe(options);
  // Compilation workers already run off the UI thread; avoid a nested full-packet clone.
  if (!createWorker && (typeof Worker === "undefined" || typeof window === "undefined" || !packetPreparationIsLarge(packet))) {
    validateRenderPacket(packet, options); return;
  }
  await new Promise<void>((resolve, reject) => {
    const worker = createWorker?.() ?? new Worker(new URL("./packetPreparationWorker.js", import.meta.url), { type: "module" });
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true; signal?.removeEventListener("abort", abort);
      worker.onmessage = null; worker.onerror = null; worker.terminate();
      if (error !== undefined) reject(error); else resolve();
    };
    const abort = () => finish(signal?.reason ?? new DOMException("Packet validation cancelled.", "AbortError"));
    worker.onmessage = ({ data }) => {
      if (signal?.aborted) { abort(); return; }
      if (data?.error !== undefined) finish(new Error(data.error));
      else if (data?.validated === true) finish();
      else finish(new Error("Packet worker returned an invalid validation result."));
    };
    worker.onerror = event => finish(new Error(event.message || "Packet validation worker failed."));
    signal?.addEventListener("abort", abort, { once: true });
    try { signal?.throwIfAborted(); worker.postMessage({ packet, options, validateOnly: true }); }
    catch (error) { finish(error); }
  });
}
