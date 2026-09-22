/// <reference types="@webgpu/types" />
import type { DeviceSession } from "./deviceSession.js";
import { GpuParticleBurstStage } from "./gpuParticleBurstStage.js";
import type { GpuParticleBurstEvent, GpuParticleBurstEvidence, GpuParticleBurstOptions,
  PackedGpuParticleBurstFrame } from "./gpuParticleBurstTypes.js";
import { gpuValidatedStage } from "./gpuValidatedStage.js";
import {
  GPU_PARTICLE_FRAME_UNIFORM_BYTES, GPU_PARTICLE_INDIRECT_BYTES, GPU_PARTICLE_STRIDE,
  GPU_PARTICLE_WORKGROUP_SIZE, packGpuParticleFrame, packGpuParticleSeeds,
  resolveGpuParticleCapacity, type GpuParticleCapacityEvidence, type GpuParticleFrameInput,
  type GpuParticleSeed,
} from "./gpuParticleTypes.js";
import { GPU_PARTICLE_COMPUTE_WGSL, GPU_PARTICLE_RENDER_WGSL } from "./gpuParticleWgsl.js";
import { GPU_PARTICLE_INDIRECT_DCIR } from "./gpuParticleIndirectDcir.js";
import { runResourceCleanup } from "./resourceCleanup.js";

interface ParticleSlot {
  readonly state: GPUBuffer;
  readonly counter: GPUBuffer;
  readonly indirect: GPUBuffer;
  readonly renderBinding: GPUBindGroup;
}
export interface GpuParticleRuntimeOptions {
  readonly capacity?: number;
  readonly initialParticles?: readonly GpuParticleSeed[];
  readonly burst?: GpuParticleBurstOptions;
}
export interface GpuParticleRuntimeFrameInput extends GpuParticleFrameInput {
  readonly bursts?: readonly GpuParticleBurstEvent[];
}
export interface GpuParticleRenderBinding {
  readonly bindGroupIndex: 0;
  readonly bindGroup: GPUBindGroup;
  readonly stateBuffer: GPUBuffer;
  readonly indirectBuffer: GPUBuffer;
  readonly capacity: number;
  readonly stride: typeof GPU_PARTICLE_STRIDE;
}
export interface GpuParticleSnapshot {
  readonly frame: number;
  readonly generation: number;
  readonly deviceEpoch: string;
  readonly deltaTime: number;
  readonly binding: GpuParticleRenderBinding;
  readonly capacityEvidence: GpuParticleCapacityEvidence;
  readonly burstEvidence?: GpuParticleBurstEvidence;
}
export interface GpuParticleFrameResult {
  readonly frame: number;
  readonly status: "committed" | "superseded" | "cancelled" | "failed";
  readonly snapshot?: GpuParticleSnapshot;
  readonly error?: unknown;
}

/** Fixed-capacity GPU simulation with compacted double-buffer publication and indirect drawing. */
export class GpuParticleRuntime {
  readonly deviceEpoch: string;
  readonly capacityEvidence: GpuParticleCapacityEvidence;
  readonly renderShader = GPU_PARTICLE_RENDER_WGSL;
  private readonly buffers: GPUBuffer[] = [];
  private renderLayoutValue!: GPUBindGroupLayout;
  private slots!: readonly [ParticleSlot, ParticleSlot];
  private frameUniform!: GPUBuffer;
  private computeGroups!: readonly [GPUBindGroup, GPUBindGroup];
  private pipelines!: Readonly<Record<"reset" | "simulate" | "indirect", GPUComputePipeline>>;
  private readonly allocationChecked: Promise<void>;
  private activeSlot = 0;
  private generation = 0;
  private nextFrame = 0;
  private activeRequest: { readonly generation: number; readonly controller: AbortController } | undefined;
  private retirement: Promise<void> | undefined;
  private snapshot: GpuParticleSnapshot | undefined;
  private terminal: Error | undefined;
  private burstStage: GpuParticleBurstStage | undefined;
  private disposed = false;
  private released = false;

  constructor(private readonly session: DeviceSession, deviceEpoch: string,
    options: GpuParticleRuntimeOptions = {}) {
    if (session.state !== "ready") throw new Error("GPU session is not ready for particles.");
    if (!/^[0-9A-Za-z][0-9A-Za-z._:-]{0,127}$/.test(deviceEpoch)) throw new TypeError("Invalid particle device epoch.");
    this.deviceEpoch = deviceEpoch;
    const seeds = options.initialParticles ?? [];
    this.capacityEvidence = resolveGpuParticleCapacity(session.device, options.capacity, seeds.length);
    let staged: ReturnType<typeof gpuValidatedStage<void>>;
    try { staged = gpuValidatedStage(session.device, () => {
      const device = session.device;
      const computeModule = device.createShaderModule({ label: "Deep GPU particle compute WGSL",
        code: GPU_PARTICLE_COMPUTE_WGSL });
      const indirectModule = device.createShaderModule({ label: "Deep GPU particle indirect DCIR",
        code: GPU_PARTICLE_INDIRECT_DCIR.code });
      const computeLayout = device.createBindGroupLayout({ label: "Deep GPU particle compute layout", entries: [
        storage(0, true), storage(1), storage(2), storage(3), storage(4),
        { binding: 5, visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform", minBindingSize: GPU_PARTICLE_FRAME_UNIFORM_BYTES } },
      ] });
      const pipelineLayout = device.createPipelineLayout({ label: "Deep GPU particle compute pipeline layout",
        bindGroupLayouts: [computeLayout] });
      const pipeline = (label: string, entryPoint: string) => device.createComputePipeline({ label,
        layout: pipelineLayout, compute: { module: computeModule, entryPoint } });
      this.pipelines = Object.freeze({ reset: pipeline("Deep particle reset pipeline", "resetOutput"),
        simulate: pipeline("Deep particle simulation pipeline", "simulateAndCompact"),
        indirect: device.createComputePipeline({ label: "Deep particle indirect DCIR pipeline",
          layout: pipelineLayout, compute: { module: indirectModule, entryPoint: "write_particle_indirect" } }) });
      this.renderLayoutValue = device.createBindGroupLayout({ label: "Deep GPU particle render layout", entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ] });
      this.frameUniform = this.allocate("Deep particle frame uniform", GPU_PARTICLE_FRAME_UNIFORM_BYTES,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      this.slots = Object.freeze([this.allocateSlot(0), this.allocateSlot(1)]);
      this.computeGroups = Object.freeze([this.computeBinding(computeLayout, 0, 1),
        this.computeBinding(computeLayout, 1, 0)]);
      this.burstStage = options.burst
        ? new GpuParticleBurstStage(session, this.capacityEvidence.capacity, options.burst, this.slots) : undefined;
      this.initialize(seeds); return undefined;
    }, "GPU particle allocation failed"); }
    catch (error) { this.releaseNow(); throw error; }
    this.allocationChecked = staged.checked; void staged.checked.catch(() => {});
    void session.device.lost.then(reason => this.handleDeviceLoss(reason),
      reason => this.handleDeviceLoss(reason)).catch(() => undefined);
  }

  get current(): GpuParticleSnapshot | undefined {
    return !this.disposed && !this.terminal && this.session.state === "ready" ? this.snapshot : undefined;
  }
  get renderLayout(): GPUBindGroupLayout { return this.renderLayoutValue; }

  async beginFrame(input: GpuParticleRuntimeFrameInput, signal?: AbortSignal): Promise<GpuParticleFrameResult> {
    if (this.disposed) throw new Error("GPU particle runtime is disposed.");
    const frame = this.reserveFrame(input.frame);
    let packed: ReturnType<typeof packGpuParticleFrame>, burstPacket: PackedGpuParticleBurstFrame | undefined;
    try { packed = packGpuParticleFrame(input, this.capacityEvidence.capacity);
      if (input.bursts !== undefined && !this.burstStage
        && (!Array.isArray(input.bursts) || input.bursts.length > 0)) {
        throw new Error("Particle burst support is not configured.");
      }
      burstPacket = this.burstStage?.prepare(input.bursts ?? [], frame, this.capacityEvidence.capacity); }
    catch (error) { return result(frame, "failed", this.current, error); }
    if (signal !== undefined && !isAbortSignal(signal)) {
      return result(frame, "failed", this.current, new TypeError("Particle frame signal is invalid."));
    }
    if (signal?.aborted) return result(frame, "cancelled", this.current, signal.reason);
    if (this.terminal || this.session.state !== "ready") {
      return result(frame, "failed", undefined, this.terminal ?? new Error("Particle device is not ready."));
    }
    const generation = ++this.generation;
    this.activeRequest?.controller.abort(abortError("GPU particle frame was superseded."));
    const controller = new AbortController(), unlink = signal ? relayAbort(signal, controller) : () => {};
    this.activeRequest = { generation, controller };
    try {
      await waitForAbort(Promise.all([this.allocationChecked, this.retirement ?? Promise.resolve()]), controller.signal);
      this.assertCurrent(generation, controller.signal);
      this.session.device.queue.writeBuffer(this.frameUniform, 0, packed.bytes);
      const target = this.activeSlot === 0 ? 1 : 0;
      if (burstPacket) this.burstStage?.upload(burstPacket);
      const encoded = gpuValidatedStage(this.session.device, () => this.encode(target, burstPacket),
        "GPU particle command encoding failed");
      void encoded.checked.catch(() => {}); controller.signal.throwIfAborted();
      this.session.device.queue.submit([encoded.value]);
      const workDone = Promise.resolve().then(() => this.session.device.queue.onSubmittedWorkDone());
      const completion = Promise.all([encoded.checked, workDone]);
      const retirement = Promise.allSettled([encoded.checked, workDone]).then(() => {});
      this.retirement = retirement;
      void retirement.then(() => { if (this.retirement === retirement) this.retirement = undefined; });
      await waitForAbort(completion, controller.signal); this.assertCurrent(generation, controller.signal);
      this.activeSlot = target;
      const snapshot = Object.freeze({ frame, generation, deviceEpoch: this.deviceEpoch,
        deltaTime: packed.deltaTime, binding: this.binding(target), capacityEvidence: this.capacityEvidence,
        ...(burstPacket ? { burstEvidence: burstPacket.evidence } : {}) });
      this.snapshot = snapshot; return result(frame, "committed", snapshot);
    } catch (error) {
      const status = generation !== this.generation ? "superseded"
        : controller.signal.aborted ? "cancelled" : "failed";
      return result(frame, status, this.current, error);
    } finally {
      unlink(); if (this.activeRequest?.generation === generation) this.activeRequest = undefined;
    }
  }

  encodeDraw(pass: GPURenderPassEncoder): boolean {
    const binding = this.current?.binding; if (!binding) return false;
    pass.setBindGroup(binding.bindGroupIndex, binding.bindGroup); pass.drawIndirect(binding.indirectBuffer, 0);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.generation++; this.snapshot = undefined;
    this.activeRequest?.controller.abort(abortError("GPU particle runtime was disposed."));
    this.activeRequest = undefined; this.retireResources(false);
  }

  private allocateSlot(index: number): ParticleSlot {
    const capacity = this.capacityEvidence.capacity;
    const state = this.allocate(`Deep particle state ${index}`, capacity * GPU_PARTICLE_STRIDE,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    const counter = this.allocate(`Deep particle counter ${index}`, 4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    const indirect = this.allocate(`Deep particle indirect ${index}`, GPU_PARTICLE_INDIRECT_BYTES,
      GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    const renderBinding = this.session.device.createBindGroup({ label: `Deep particle render bindings ${index}`,
      layout: this.renderLayout, entries: [{ binding: 0, resource: { buffer: state } }] });
    return { state, counter, indirect, renderBinding };
  }
  private allocate(label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer {
    const buffer = this.session.own(this.session.device.createBuffer({ label, size, usage }));
    this.buffers.push(buffer); return buffer;
  }
  private computeBinding(layout: GPUBindGroupLayout, input: number, output: number): GPUBindGroup {
    const source = this.slots[input]!, target = this.slots[output]!;
    return this.session.device.createBindGroup({ label: `Deep particle compute ${input}->${output}`, layout,
      entries: [source.state, source.counter, target.state, target.counter, target.indirect, this.frameUniform]
        .map((buffer, binding) => ({ binding, resource: { buffer } })) });
  }
  private initialize(seeds: readonly GpuParticleSeed[]): void {
    const queue = this.session.device.queue, packed = packGpuParticleSeeds(seeds, this.capacityEvidence.capacity);
    if (packed.byteLength) queue.writeBuffer(this.slots[0]!.state, 0, packed);
    const zero = new Uint32Array([0]), initial = new Uint32Array([6, seeds.length, 0, 0]);
    queue.writeBuffer(this.slots[0]!.counter, 0, new Uint32Array([seeds.length]));
    queue.writeBuffer(this.slots[1]!.counter, 0, zero);
    queue.writeBuffer(this.slots[0]!.indirect, 0, initial);
    queue.writeBuffer(this.slots[1]!.indirect, 0, new Uint32Array([6, 0, 0, 0]));
  }
  private encode(target: number, burstPacket?: PackedGpuParticleBurstFrame): GPUCommandBuffer {
    const encoder = this.session.device.createCommandEncoder({ label: "Deep GPU particle frame" });
    const pass = encoder.beginComputePass({ label: "Deep GPU particle simulation" });
    pass.setBindGroup(0, this.computeGroups[this.activeSlot]!);
    pass.setPipeline(this.pipelines.reset); pass.dispatchWorkgroups(1);
    pass.setPipeline(this.pipelines.simulate);
    pass.dispatchWorkgroups(Math.ceil(this.capacityEvidence.capacity / GPU_PARTICLE_WORKGROUP_SIZE));
    const burstEncoded = burstPacket ? this.burstStage?.encode(pass, target, burstPacket) : false;
    pass.setPipeline(this.pipelines.indirect);
    if (burstEncoded) pass.setBindGroup(0, this.computeGroups[this.activeSlot]!);
    pass.dispatchWorkgroups(1); pass.end();
    return encoder.finish();
  }
  private binding(index: number): GpuParticleRenderBinding {
    const slot = this.slots[index]!;
    return Object.freeze({ bindGroupIndex: 0, bindGroup: slot.renderBinding, stateBuffer: slot.state,
      indirectBuffer: slot.indirect, capacity: this.capacityEvidence.capacity, stride: GPU_PARTICLE_STRIDE });
  }
  private reserveFrame(requested: number | undefined): number {
    const frame = requested ?? this.nextFrame;
    if (!Number.isSafeInteger(frame) || frame < this.nextFrame) throw new RangeError("Particle frame regressed.");
    this.nextFrame = frame + 1; return frame;
  }
  private assertCurrent(generation: number, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (generation !== this.generation) throw abortError("GPU particle frame is stale.");
    if (this.terminal || this.session.state !== "ready") throw this.terminal ?? new Error("Particle device is not ready.");
  }
  private handleDeviceLoss(reason: unknown): void {
    if (this.disposed || this.terminal) return;
    this.terminal = new Error(`Particle device epoch ${this.deviceEpoch} was lost: ${message(reason)}`);
    this.generation++; this.snapshot = undefined;
    this.activeRequest?.controller.abort(this.terminal); this.activeRequest = undefined; this.retireResources(true);
  }
  private retireResources(immediate: boolean): void {
    const release = () => this.releaseNow();
    if (!immediate && this.retirement) void this.retirement.then(release).catch(() => undefined); else release();
  }
  private releaseNow(): void {
    if (this.released) return; this.released = true;
    this.burstStage?.dispose(); this.burstStage = undefined;
    runResourceCleanup("GPU particle resource disposal failed.", this.buffers.map(buffer =>
      () => this.session.release(buffer)));
  }
}

function storage(binding: number, readOnly = false): GPUBindGroupLayoutEntry {
  return { binding, visibility: GPUShaderStage.COMPUTE,
    buffer: { type: readOnly ? "read-only-storage" : "storage" } };
}
function relayAbort(source: AbortSignal, target: AbortController): () => void {
  const abort = () => target.abort(source.reason ?? abortError("GPU particle frame was cancelled."));
  if (source.aborted) abort(); else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}
function isAbortSignal(value: unknown): value is AbortSignal {
  return !!value && typeof value === "object" && typeof (value as AbortSignal).aborted === "boolean"
    && typeof (value as AbortSignal).addEventListener === "function";
}
async function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let reject!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_, fail) => { reject = fail; });
  const abort = () => reject(signal.reason ?? abortError("GPU particle frame was cancelled."));
  signal.addEventListener("abort", abort, { once: true });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}
function result(frame: number, status: GpuParticleFrameResult["status"],
  snapshot?: GpuParticleSnapshot, error?: unknown): GpuParticleFrameResult {
  return Object.freeze({ frame, status, ...(snapshot ? { snapshot } : {}),
    ...(error === undefined ? {} : { error }) });
}
function abortError(text: string): Error { const error = new Error(text); error.name = "AbortError"; return error; }
function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }
