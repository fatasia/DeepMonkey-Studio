import type { DeviceSession } from "../webgpu/deviceSession.js";
import { gpuValidatedStage } from "../webgpu/gpuValidatedStage.js";
import { failWithResourceCleanup, runResourceCleanup } from "../webgpu/resourceCleanup.js";
import {
  packProbeLevels, packProbeUpdates, probeProfileSignature, sameProbeLevels,
  validateProbeClipmapResourcePlan,
} from "./probeClipmapResourceData.js";
import {
  type ProbeClipmapPlan, type ProbeClipmapProfile,
} from "./probeClipmapPlan.js";

const DEVICE_EPOCH = /^[0-9A-Za-z][0-9A-Za-z._:-]{0,127}$/;

export interface ProbeClipmapGpuResource {
  readonly deviceEpoch: string;
  readonly profileKey: string;
  readonly probeStorageBuffer: GPUBuffer;
  readonly updateListBuffer: GPUBuffer;
  readonly levelMetadataBuffer: GPUBuffer;
  readonly plan: ProbeClipmapPlan;
  readonly allocatedBytes: number;
}
export interface ProbeClipmapResourceEvidence {
  readonly generation: number;
  readonly allocatedBytes: number;
  readonly updatedBytes: number;
  readonly updateCount: number;
  readonly createdBufferCount: number;
  readonly reusedBufferCount: number;
}
export interface ProbeClipmapResourceUpdate {
  readonly status: "created" | "reused";
  readonly resource: ProbeClipmapGpuResource;
  readonly evidence: ProbeClipmapResourceEvidence;
}

interface Allocation {
  readonly profileKey: string;
  readonly probeStorageBuffer: GPUBuffer;
  readonly updateListBuffer: GPUBuffer;
  readonly levelMetadataBuffer: GPUBuffer;
  readonly allocatedBytes: number;
}
interface Pending {
  readonly generation: number;
  readonly controller: AbortController;
  readonly allocation: Allocation;
  readonly resource: ProbeClipmapGpuResource;
  readonly evidence: ProbeClipmapResourceEvidence;
  released: boolean;
}

/** Owns the bounded GPU buffers for a CPU probe plan; it does not render or dispatch GI work. */
export class ProbeClipmapResources {
  readonly deviceEpoch: string;
  private allocation: Allocation | undefined;
  private active: ProbeClipmapGpuResource | undefined;
  private pending: Pending | undefined;
  private generation = 0;
  private disposed = false;

  constructor(private readonly session: DeviceSession, deviceEpoch: string) {
    if (typeof deviceEpoch !== "string" || !DEVICE_EPOCH.test(deviceEpoch)) {
      throw new TypeError("Probe clipmap device epoch is not canonical.");
    }
    this.deviceEpoch = deviceEpoch;
  }

  get current(): ProbeClipmapGpuResource | undefined { return this.active; }

  async setValidated(plan: ProbeClipmapPlan, deviceEpoch: string,
    signal?: AbortSignal): Promise<ProbeClipmapResourceUpdate> {
    if (signal?.aborted) throw cancellation(signal, "Probe clipmap update cancelled.");
    this.assertReady(deviceEpoch); validateProbeClipmapResourcePlan(plan, this.session.device);
    const generation = ++this.generation;
    this.cancelPending("Superseded probe clipmap generation.");
    const profileKey = probeProfileSignature(plan.profile);

    if (this.allocation?.profileKey === profileKey && this.active) {
      const metadataChanged = !sameProbeLevels(this.active.plan.levels, plan.levels);
      const updatedBytes = this.writePlan(this.allocation, plan, metadataChanged, signal);
      this.assertReady(deviceEpoch);
      if (signal?.aborted) throw cancellation(signal, "Probe clipmap update cancelled.");
      this.active = snapshot(this.allocation, plan, this.deviceEpoch);
      return result("reused", this.active, evidence(generation, this.allocation.allocatedBytes,
        updatedBytes, plan.updates.length, 0, 3));
    }

    const controller = new AbortController(), unlink = signal ? relayAbort(signal, controller) : () => {};
    let candidate: Allocation | undefined;
    let staged: ReturnType<typeof gpuValidatedStage<ProbeClipmapGpuResource>>;
    let updatedBytes = 0;
    try {
      staged = gpuValidatedStage(this.session.device, () => {
        candidate = this.allocate(plan.profile, profileKey);
        updatedBytes = this.writePlan(candidate, plan, true, controller.signal);
        return snapshot(candidate, plan, this.deviceEpoch);
      }, "Probe clipmap GPU preparation failed");
    } catch (error) {
      if (candidate) failWithResourceCleanup(error, "Probe clipmap staging failed",
        [() => this.release(candidate!)]);
      throw error;
    }
    const updateEvidence = evidence(generation, candidate!.allocatedBytes, updatedBytes,
      plan.updates.length, 3, 0);
    const pending: Pending = { generation, controller, allocation: candidate!,
      resource: staged.value, evidence: updateEvidence, released: false };
    this.pending = pending;
    try {
      await waitForValidation(staged.checked, controller.signal);
      if (this.pending !== pending || generation !== this.generation || controller.signal.aborted
        || this.session.state !== "ready") {
        throw cancellation(controller.signal, "Probe clipmap generation is stale.");
      }
      this.pending = undefined;
      const previous = this.allocation;
      this.allocation = pending.allocation; this.active = pending.resource;
      if (previous) this.release(previous);
      return result("created", this.active, pending.evidence);
    } catch (error) {
      if (this.pending === pending) this.pending = undefined;
      try { this.releasePending(pending); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Probe clipmap rollback failed."); }
      throw error;
    } finally { unlink(); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.generation++;
    const pending = this.pending, allocation = this.allocation;
    this.pending = undefined; this.allocation = undefined; this.active = undefined;
    pending?.controller.abort(abortError("Probe clipmap resources disposed."));
    runResourceCleanup("Probe clipmap disposal failed.", [
      () => { if (pending) this.releasePending(pending); },
      () => { if (allocation) this.release(allocation); },
    ]);
  }

  private allocate(profile: ProbeClipmapProfile, profileKey: string): Allocation {
    const created: GPUBuffer[] = [], device = this.session.device;
    const buffer = (label: string, size: number): GPUBuffer => {
      const value = this.session.own(device.createBuffer({ label, size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
      created.push(value); return value;
    };
    try {
      return {
        profileKey,
        probeStorageBuffer: buffer("Deep GI probe storage", profile.probeStorageBytes),
        updateListBuffer: buffer("Deep GI probe update list", profile.updateListBytes),
        levelMetadataBuffer: buffer("Deep GI probe level metadata", profile.levelMetadataBytes),
        allocatedBytes: profile.estimatedBytes,
      };
    } catch (error) {
      failWithResourceCleanup(error, "Probe clipmap allocation failed",
        created.map(resource => () => this.session.release(resource)));
    }
  }

  private writePlan(allocation: Allocation, plan: ProbeClipmapPlan,
    writeMetadata: boolean, signal?: AbortSignal): number {
    signal?.throwIfAborted();
    let bytes = 0;
    if (plan.updates.length) {
      const updates = packProbeUpdates(plan.updates);
      this.session.device.queue.writeBuffer(allocation.updateListBuffer, 0, updates);
      bytes += updates.byteLength; signal?.throwIfAborted();
    }
    if (writeMetadata) {
      const metadata = packProbeLevels(plan.levels);
      this.session.device.queue.writeBuffer(allocation.levelMetadataBuffer, 0, metadata);
      bytes += metadata.byteLength; signal?.throwIfAborted();
    }
    return bytes;
  }

  private assertReady(deviceEpoch: string): void {
    if (this.disposed) throw new Error("Probe clipmap resources are disposed.");
    if (deviceEpoch !== this.deviceEpoch) throw new Error("Probe clipmap device epoch mismatch.");
    if (this.session.state !== "ready") throw new Error("Probe clipmap device session is not ready.");
  }

  private cancelPending(message: string): void {
    const pending = this.pending; if (!pending) return;
    this.pending = undefined; pending.controller.abort(abortError(message)); this.releasePending(pending);
  }
  private releasePending(pending: Pending): void {
    if (pending.released) return; pending.released = true; this.release(pending.allocation);
  }
  private release(allocation: Allocation): void {
    runResourceCleanup("Probe clipmap buffer disposal failed.", [
      () => this.session.release(allocation.probeStorageBuffer),
      () => this.session.release(allocation.updateListBuffer),
      () => this.session.release(allocation.levelMetadataBuffer),
    ]);
  }
}

function snapshot(allocation: Allocation, plan: ProbeClipmapPlan, deviceEpoch: string): ProbeClipmapGpuResource {
  return Object.freeze({ deviceEpoch, profileKey: allocation.profileKey,
    probeStorageBuffer: allocation.probeStorageBuffer, updateListBuffer: allocation.updateListBuffer,
    levelMetadataBuffer: allocation.levelMetadataBuffer, plan, allocatedBytes: allocation.allocatedBytes });
}
function evidence(generation: number, allocatedBytes: number, updatedBytes: number,
  updateCount: number, createdBufferCount: number, reusedBufferCount: number): ProbeClipmapResourceEvidence {
  return Object.freeze({ generation, allocatedBytes, updatedBytes, updateCount, createdBufferCount, reusedBufferCount });
}
function result(status: ProbeClipmapResourceUpdate["status"], resource: ProbeClipmapGpuResource,
  value: ProbeClipmapResourceEvidence): ProbeClipmapResourceUpdate {
  return Object.freeze({ status, resource, evidence: value });
}
function relayAbort(source: AbortSignal, target: AbortController): () => void {
  const abort = () => target.abort(source.reason);
  if (source.aborted) abort(); else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}
async function waitForValidation(checked: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) { void checked.catch(() => {}); throw cancellation(signal, "Probe clipmap update cancelled."); }
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(cancellation(signal, "Probe clipmap update cancelled."));
  signal.addEventListener("abort", onAbort, { once: true });
  try { await Promise.race([checked, aborted]); } finally { signal.removeEventListener("abort", onAbort); }
}
function abortError(message: string): Error { const error = new Error(message); error.name = "AbortError"; return error; }
function cancellation(signal: AbortSignal, message: string): Error {
  return signal.reason instanceof Error ? signal.reason : abortError(message);
}
