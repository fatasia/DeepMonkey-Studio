import { retainPacketSkinningInputs } from "./packetPreparationOwnership.js";
import { yieldProbePlan } from "./lighting/probeClipmapPlanYield.js";
import type { MaterialInstanceOptions } from "./materialInstanceAbi.js";
import type { PreparedPacket, RenderPacket } from "./renderPacket.js";
import { assertPacketCloneSafe, buildPacketPreparationWork, type PacketPreparationWork } from "./packetPreparationWork.js";

export interface PacketPreparationWorkerHost {
  onmessage: ((event: { data: { work?: PacketPreparationWork; error?: string } }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  postMessage(value: unknown): void;
  terminate(): void;
}
declare const Worker: new (url: URL, options: { type: "module" }) => PacketPreparationWorkerHost;

export async function prepareRenderPacketAsync(packet: RenderPacket, options: MaterialInstanceOptions = {},
  signal?: AbortSignal): Promise<PreparedPacket> {
  return (await prepareGpuPacketWork(packet, options, signal)).prepared;
}

/** One bounded worker per candidate, terminated on completion/cancellation. Input buffers stay owned by the caller. */
export async function prepareGpuPacketWork(packet: RenderPacket, options: MaterialInstanceOptions = {},
  signal?: AbortSignal, skinInputs = false,
  createWorker: () => PacketPreparationWorkerHost = () => new Worker(new URL("./packetPreparationWorker.js", import.meta.url), { type: "module" })):
  Promise<PacketPreparationWork> {
  signal?.throwIfAborted();
  if (typeof Worker === "undefined") return buildPacketPreparationWork(packet, options, skinInputs);
  assertPacketCloneSafe(packet); assertPacketCloneSafe(options);
  if (!packetPreparationIsLarge(packet)) return buildPacketPreparationWork(packet, options, skinInputs);
  await yieldProbePlan(); signal?.throwIfAborted();
  return new Promise<PacketPreparationWork>((resolve, reject) => {
    const worker = createWorker(); let settled = false;
    const finish = (work?: PacketPreparationWork, error?: unknown): void => {
      if (settled) return; settled = true;
      signal?.removeEventListener("abort", abort); worker.onmessage = null; worker.onerror = null; worker.terminate();
      if (error !== undefined) reject(error); else resolve(work!);
    };
    const abort = (): void => finish(undefined, signal?.reason ?? Object.assign(new Error("Packet preparation cancelled."), { name: "AbortError" }));
    worker.onmessage = (event: { data: { work?: PacketPreparationWork; error?: string } }) => {
      if (signal?.aborted) { abort(); return; }
      if (event.data.error !== undefined) finish(undefined, new Error(event.data.error));
      else if (event.data.work) {
        try { finish(retainPacketSkinningInputs(event.data.work)); } catch (error) { finish(undefined, error); }
      }
      else finish(undefined, new Error("Packet worker returned an invalid result."));
    };
    worker.onerror = event => finish(undefined, new Error(event.message || "Packet preparation worker failed."));
    signal?.addEventListener("abort", abort, { once: true });
    try { signal?.throwIfAborted(); worker.postMessage({ packet, options, skinInputs }); }
    catch (error) { finish(undefined, error); }
  });
}

export function packetPreparationIsLarge(packet: RenderPacket): boolean {
  assertPacketCloneSafe(packet);
  return packet.geometries.reduce((sum, geometry) => sum + geometry.vertices.length, 0) > 48_000
    || (packet.textures ?? []).reduce((sum, texture) => sum + ("data" in texture ? texture.data.byteLength : 0), 0) > 1_048_576;
}
