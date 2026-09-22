/// <reference types="@webgpu/types" />
import type { DeviceSession } from "./deviceSession.js";
import {
  GPU_LOD_LEVEL_STRIDE,
  GPU_LOD_MAX_LEVELS,
  GPU_LOD_OBJECT_STRIDE,
  GPU_LOD_OUTPUT_STRIDE,
  GPU_LOD_UNIFORM_SIZE,
  type GpuLodInput,
  type GpuLodResult,
  type GpuLodSelectorOptions,
  type GpuLodView,
} from "./gpuLodTypes.js";
import { cameraSignatureJumped, validateGpuLodRequest, type ValidatedGpuLodRequest } from "./gpuLodValidation.js";
import { GPU_LOD_WGSL } from "./gpuLodWgsl.js";
import { failWithResourceCleanup, runResourceCleanup } from "./resourceCleanup.js";

interface LodResources {
  readonly capacity: number;
  readonly history: GPUBuffer;
  readonly records: GPUBuffer;
  readonly uniform: GPUBuffer;
  readonly inputObjects: GPUBuffer;
  readonly inputLevels: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
}

interface InputIdentity {
  readonly revision: number;
  readonly count: number;
  readonly objects: GPUBuffer;
  readonly levels: GPUBuffer;
}

interface LastSelection {
  readonly identity: InputIdentity;
  readonly signature: readonly number[];
  readonly result: GpuLodResult;
}

interface PendingSelection {
  readonly candidate: LodResources;
  readonly previous: LodResources | undefined;
  readonly identity: InputIdentity;
  readonly signature: readonly number[];
  readonly result: GpuLodResult;
}

/** Stateful GPU screen-space LOD selection. Output order always equals object input order. */
export class GpuLodSelector {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private readonly options: Readonly<GpuLodSelectorOptions>;
  private resources: LodResources | undefined;
  private identity: InputIdentity | undefined;
  private cameraSignature: readonly number[] | undefined;
  private last: LastSelection | undefined;
  private pending: PendingSelection | undefined;
  private readonly uploadedUniforms = new WeakMap<GPUBuffer, ArrayBuffer>();
  private historyInvalidated = true;
  private disposed = false;

  constructor(private readonly session: DeviceSession, options: GpuLodSelectorOptions = {}) {
    if (session.state !== "ready") throw new Error("GPU session is not ready for LOD selection.");
    this.options = Object.freeze({ ...options });
    const device = session.device, module = device.createShaderModule({ label: "Deep GPU LOD selection WGSL", code: GPU_LOD_WGSL });
    this.layout = device.createBindGroupLayout({ label: "Deep GPU LOD selection layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
    ] });
    const pipelineLayout = device.createPipelineLayout({ label: "Deep GPU LOD pipeline layout", bindGroupLayouts: [this.layout] });
    this.pipeline = device.createComputePipeline({ label: "Deep GPU LOD selection pipeline", layout: pipelineLayout,
      compute: { module, entryPoint: "selectLod" } });
  }

  encode(encoder: GPUCommandEncoder, input: GpuLodInput, view: GpuLodView): GpuLodResult {
    this.assertReady();
    if (this.pending) throw new Error("A GPU LOD selection is already pending submission.");
    const request = validateGpuLodRequest(this.session.device, input, view, this.options);
    this.validateRevision(input);
    if (!this.historyInvalidated && !request.cameraJump && this.last && exactLast(this.last, input, request)) {
      return Object.freeze({ ...this.last.result, updated: false });
    }
    const previous = this.resources;
    const reusable = previous !== undefined && previous.capacity >= input.count && request.capacity * 4 >= previous.capacity;
    const bindingChanged = previous !== undefined && (previous.inputObjects !== input.objects || previous.inputLevels !== input.levels);
    const countChanged = this.identity !== undefined && this.identity.count !== input.count;
    const capacityChanged = !reusable;
    const automaticJump = cameraSignatureJumped(this.cameraSignature, request.camera.signature, request.cameraJumpThreshold);
    const historyReset = this.historyInvalidated || request.cameraJump || automaticJump || bindingChanged || countChanged || capacityChanged;
    let candidate: LodResources | undefined;
    try {
      candidate = reusable ? bindingChanged ? this.rebind(previous, input) : previous : this.allocate(request.capacity, input);
      this.writeUniform(candidate.uniform, input.count, request, historyReset);
      if (input.count > 0) {
        const pass = encoder.beginComputePass({ label: "Deep deterministic GPU LOD selection" });
        pass.setPipeline(this.pipeline); pass.setBindGroup(0, candidate.bindGroup);
        pass.dispatchWorkgroups(request.workgroups); pass.end();
      }
      const result: GpuLodResult = Object.freeze({ inputCount: input.count, capacity: candidate.capacity,
        records: candidate.records, recordStride: GPU_LOD_OUTPUT_STRIDE, historyReset, updated: true,
        budgetMode: "deferred-stable-prefix" });
      this.pending = { candidate, previous, identity: identity(input), signature: request.camera.signature, result };
      return result;
    } catch (error) {
      this.last = undefined; this.historyInvalidated = true;
      failWithResourceCleanup(error, "GPU LOD selection encoding failed.",
        [() => { if (candidate && candidate.records !== previous?.records) this.release(candidate); }]);
    }
  }

  /** Publishes selection history only after queue.submit returns successfully. */
  commit(result: GpuLodResult): void {
    this.assertReady();
    const pending = this.assertPending(result);
    this.resources = pending.candidate;
    this.identity = pending.identity; this.cameraSignature = pending.signature;
    this.last = { identity: pending.identity, signature: pending.signature, result };
    this.historyInvalidated = false; this.pending = undefined;
    if (pending.previous && pending.previous.records !== pending.candidate.records) this.release(pending.previous);
  }

  /** Cancels an encoder known not to have been submitted and preserves committed history. */
  cancel(result: GpuLodResult): void {
    const pending = this.assertPending(result);
    this.pending = undefined;
    if (pending.candidate.records !== pending.previous?.records) this.release(pending.candidate);
  }

  /** Fails closed after uncertain submission and resets hysteresis on the retry. */
  fail(result: GpuLodResult): void {
    const pending = this.assertPending(result);
    this.pending = undefined; this.last = undefined; this.historyInvalidated = true;
    if (pending.candidate.records !== pending.previous?.records) this.release(pending.candidate);
  }

  resetHistory(): void {
    if (this.pending) throw new Error("Cannot reset GPU LOD history while a selection is pending submission.");
    this.cameraSignature = undefined; this.last = undefined; this.historyInvalidated = true;
  }

  dispose(): void {
    if (this.disposed) return;
    const pending = this.pending, resources = this.resources;
    this.disposed = true; this.pending = undefined;
    this.resources = undefined; this.identity = undefined; this.cameraSignature = undefined; this.last = undefined;
    runResourceCleanup("GPU LOD selector disposal failed.", [
      () => { if (pending && pending.candidate.records !== pending.previous?.records) this.release(pending.candidate); },
      () => { if (resources) this.release(resources); },
    ]);
  }

  private allocate(capacity: number, input: GpuLodInput): LodResources {
    const created: GPUBuffer[] = [], device = this.session.device;
    const buffer = (label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer => {
      const value = this.session.own(device.createBuffer({ label, size, usage })); created.push(value); return value;
    };
    try {
      const base = { capacity,
        history: buffer("Deep GPU LOD persistent history", capacity * 4, GPUBufferUsage.STORAGE),
        records: buffer("Deep GPU LOD selection records", capacity * GPU_LOD_OUTPUT_STRIDE, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
        uniform: buffer("Deep GPU LOD view", GPU_LOD_UNIFORM_SIZE, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      };
      return { ...base, inputObjects: input.objects, inputLevels: input.levels, bindGroup: this.createBindGroup(base, input) };
    } catch (error) { failWithResourceCleanup(error, "GPU LOD allocation failed.",
      created.map(resource => () => this.session.release(resource))); }
  }

  private rebind(resources: LodResources, input: GpuLodInput): LodResources {
    return { ...resources, inputObjects: input.objects, inputLevels: input.levels,
      bindGroup: this.createBindGroup(resources, input) };
  }

  private createBindGroup(resources: Pick<LodResources, "history" | "records" | "uniform">, input: GpuLodInput): GPUBindGroup {
    const objectSize = Math.max(GPU_LOD_OBJECT_STRIDE, input.count * GPU_LOD_OBJECT_STRIDE);
    const levelSize = Math.max(GPU_LOD_MAX_LEVELS * GPU_LOD_LEVEL_STRIDE,
      input.count * GPU_LOD_MAX_LEVELS * GPU_LOD_LEVEL_STRIDE);
    return this.session.device.createBindGroup({ label: "Deep GPU LOD bindings", layout: this.layout, entries: [
      { binding: 0, resource: { buffer: input.objects, offset: 0, size: objectSize } },
      { binding: 1, resource: { buffer: input.levels, offset: 0, size: levelSize } },
      { binding: 2, resource: { buffer: resources.history } }, { binding: 3, resource: { buffer: resources.records } },
      { binding: 4, resource: { buffer: resources.uniform } },
    ] });
  }

  private writeUniform(buffer: GPUBuffer, count: number, request: ValidatedGpuLodRequest, reset: boolean): void {
    const data = new ArrayBuffer(GPU_LOD_UNIFORM_SIZE), floats = new Float32Array(data), uints = new Uint32Array(data);
    floats.set([...request.camera.position, 0], 0); floats.set([...request.camera.forward, 0], 4);
    floats.set([request.camera.projectionScale, request.camera.near, request.camera.far, request.camera.projectionMode], 8);
    uints.set([count, request.capacity, reset ? 1 : 0, 0], 12);
    if (sameWords(data, this.uploadedUniforms.get(buffer))) return;
    this.session.device.queue.writeBuffer(buffer, 0, data);
    this.uploadedUniforms.set(buffer, data);
  }

  private validateRevision(input: GpuLodInput): void {
    const before = this.identity;
    if (before && input.revision < before.revision) throw new Error("Stale GPU LOD input revision.");
    if (before && input.revision === before.revision
      && (input.count !== before.count || input.objects !== before.objects || input.levels !== before.levels)) {
      throw new Error("GPU LOD input changed without a revision.");
    }
  }

  private assertReady(): void {
    if (this.disposed) throw new Error("GPU LOD selector is disposed.");
    if (this.session.state !== "ready") {
      const pending = this.pending, resources = this.resources;
      this.pending = undefined; this.resources = undefined; this.last = undefined; this.historyInvalidated = true;
      failWithResourceCleanup(new Error("GPU session is not ready for LOD selection."),
        "GPU LOD session loss cleanup failed.", [
          () => { if (pending && pending.candidate.records !== pending.previous?.records) this.release(pending.candidate); },
          () => { if (resources) this.release(resources); },
        ]);
    }
  }

  private assertPending(result: GpuLodResult): PendingSelection {
    if (this.disposed) throw new Error("GPU LOD selector is disposed.");
    if (!this.pending || this.pending.result !== result) throw new Error("GPU LOD selection is not pending submission.");
    return this.pending;
  }

  private release(resources: LodResources): void {
    runResourceCleanup("GPU LOD resource disposal failed.", [() => this.session.release(resources.history),
      () => this.session.release(resources.records), () => this.session.release(resources.uniform)]);
  }
}

function identity(input: GpuLodInput): InputIdentity {
  return { revision: input.revision, count: input.count, objects: input.objects, levels: input.levels };
}

function exactLast(last: LastSelection, input: GpuLodInput, request: ValidatedGpuLodRequest): boolean {
  return last.identity.revision === input.revision && last.identity.count === input.count
    && last.identity.objects === input.objects && last.identity.levels === input.levels
    && last.signature.length === request.camera.signature.length
    && last.signature.every((value, index) => value === request.camera.signature[index]);
}

function sameWords(current: ArrayBuffer, previous: ArrayBuffer | undefined): boolean {
  if (!previous || current.byteLength !== previous.byteLength) return false;
  const left = new Uint32Array(current), right = new Uint32Array(previous);
  return left.every((value, index) => value === right[index]);
}
