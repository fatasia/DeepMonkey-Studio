/// <reference types="@webgpu/types" />

import {
  GPU_CULL_INDIRECT_STRIDE,
  GPU_CULL_INSTANCE_STRIDE,
  GPU_CULL_PREVIOUS_TRANSFORM_STRIDE,
  packBounds,
  packCullingInstances,
  packFrustum,
  packIndirectArgs,
  packPreviousTransforms,
  type CullingInstance,
  type Frustum,
  type IndirectDrawArgs,
} from "./gpuFrustumPacking.js";
import { failWithResourceCleanup } from "./resourceCleanup.js";
import type { DeviceSession } from "./deviceSession.js";
import { createAdmittedBuffer } from "./resourceAdmission.js";

export { cpuFrustumCull, GPU_CULL_INDIRECT_STRIDE, GPU_CULL_INSTANCE_STRIDE,
  GPU_CULL_PREVIOUS_TRANSFORM_STRIDE, packCullingInstances } from "./gpuFrustumPacking.js";
export type { CullingInstance, Frustum, IndirectDrawArgs } from "./gpuFrustumPacking.js";
const WORKGROUP_SIZE = 64;

/** Compacts complete Deep instance rows and publishes a bounded drawIndexedIndirect count. */
export const GPU_FRUSTUM_CULL_WGSL = /* wgsl */ `
struct InstanceRow { model0: vec4<f32>, model1: vec4<f32>, model2: vec4<f32>, normal0: vec4<f32>, normal1: vec4<f32>, normal2: vec4<f32>, material0: vec4<f32>, material1: vec4<f32>, material2: vec4<f32> };
struct PreviousTransform { row0: vec4<f32>, row1: vec4<f32>, row2: vec4<f32> };
struct Frustum { planes: array<vec4<f32>, 6> };
struct Params { inputCount: u32, capacity: u32, _padding: vec2<u32> };
struct Counter { count: atomic<u32> };
@group(0) @binding(0) var<storage, read> instances: array<InstanceRow>;
@group(0) @binding(1) var<storage, read> bounds: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> compacted: array<InstanceRow>;
@group(0) @binding(3) var<storage, read> frustum: Frustum;
@group(0) @binding(4) var<storage, read_write> counter: Counter;
@group(0) @binding(5) var<storage, read_write> indirect: array<u32>;
@group(0) @binding(6) var<uniform> params: Params;
@group(0) @binding(7) var<storage, read> previousTransforms: array<PreviousTransform>;
@group(0) @binding(8) var<storage, read_write> compactedPrevious: array<PreviousTransform>;
fn visible(instance: InstanceRow, bound: vec4<f32>) -> bool {
  let center = vec3<f32>(dot(instance.model0, vec4<f32>(bound.xyz, 1.0)),
    dot(instance.model1, vec4<f32>(bound.xyz, 1.0)), dot(instance.model2, vec4<f32>(bound.xyz, 1.0)));
  for (var p = 0u; p < 6u; p++) {
    let plane = frustum.planes[p];
    // The image of a sphere under an affine transform has support r * |A^T n|.
    let localNormal = instance.model0.xyz * plane.x + instance.model1.xyz * plane.y + instance.model2.xyz * plane.z;
    let support = max(bound.w, 0.0) * length(localNormal);
    if (dot(plane.xyz, center) + plane.w < -support) { return false; }
  }
  return true;
}
@compute @workgroup_size(64) fn cull(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.inputCount || id.x >= params.capacity) { return; }
  let instance = instances[id.x];
  if (visible(instance, bounds[id.x])) { let destination = atomicAdd(&counter.count, 1u); if (destination < params.capacity) { compacted[destination] = instance; compactedPrevious[destination] = previousTransforms[id.x]; } }
}
@compute @workgroup_size(1) fn writeIndirect(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x == 0u) { indirect[1] = min(atomicLoad(&counter.count), params.capacity); }
}
`;

export interface GpuCullingPhaseResources {
  readonly compacted: GPUBuffer; readonly compactedPrevious: GPUBuffer; readonly frustum: GPUBuffer; readonly counter: GPUBuffer; readonly indirect: GPUBuffer;
  readonly cullPipeline: GPUComputePipeline; readonly indirectPipeline: GPUComputePipeline; readonly bindGroup: GPUBindGroup;
  readonly capacity: number; readonly indexCount: number;
  /** Updates per-pass frustum and resets the atomic/indirect outputs before encode(). */
  writeView(queue: GPUQueue, frustum: Frustum, args?: Partial<IndirectDrawArgs>): void;
  encode(encoder: GPUCommandEncoder): void;
  dispose(): void;
}
export interface GpuCullingSharedInputs {
  readonly input: GPUBuffer; readonly previous: GPUBuffer; readonly bounds: GPUBuffer; readonly params: GPUBuffer;
  readonly capacity: number; readonly inputCount: number;
  /** Uploads the complete instance ABI and object-space bounds. Call only when the batch changes. */
  writeInstances(queue: GPUQueue, instances: readonly CullingInstance[]): void;
  /** Creates isolated per-pass output and view state backed by these stable inputs. */
  createPhase(indexCount?: number): GpuCullingPhaseResources;
  dispose(): void;
}
export interface GpuCullingPipelineContext {
  /** Creates one stable input set that shares this context's shader module, layout, and pipelines. */
  createSharedInputs(capacity: number): GpuCullingSharedInputs;
  /** Invalidates the context and releases every shared input set still owned by it. */
  dispose(): void;
}
export interface GpuCullingResources extends GpuCullingPhaseResources {
  readonly input: GPUBuffer; readonly previous: GPUBuffer; readonly bounds: GPUBuffer; readonly params: GPUBuffer; readonly inputCount: number;
  writeInstances(queue: GPUQueue, instances: readonly CullingInstance[]): void;
  writeInput(queue: GPUQueue, instances: readonly CullingInstance[], frustum: Frustum, args?: Partial<IndirectDrawArgs>): void;
}

interface GpuCullingKernel {
  readonly device: GPUDevice;
  readonly allocate: (descriptor: GPUBufferDescriptor) => GPUBuffer;
  readonly release: (buffer: GPUBuffer) => void;
  readonly layout: GPUBindGroupLayout;
  readonly cullPipeline: GPUComputePipeline;
  readonly indirectPipeline: GPUComputePipeline;
}

/** Creates immutable compute state reusable by every culling batch on one device. */
export function createGpuCullingPipelineContext(device: GPUDevice, session?: DeviceSession): GpuCullingPipelineContext {
  if (session && session.device !== device) throw new Error("Culling owner must belong to the same GPU device.");
  const module = device.createShaderModule({ label: "Deep frustum culling WGSL", code: GPU_FRUSTUM_CULL_WGSL });
  const layout = device.createBindGroupLayout({ label: "Deep frustum culling layout", entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }, { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }, { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }, { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    // Params is uniform because this kernel otherwise consumes nine storage-buffer
    // slots, exceeding the WebGPU baseline limit of eight on common adapters.
    { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: 16 } },
    { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
  ] });
  const pipelineLayout = device.createPipelineLayout({ label: "Deep frustum culling pipeline layout", bindGroupLayouts: [layout] });
  const kernel: GpuCullingKernel = {
    device, layout,
    allocate: descriptor => session ? createAdmittedBuffer(session, descriptor) : device.createBuffer(descriptor),
    release: buffer => { if (session) session.release(buffer); else buffer.destroy(); },
    cullPipeline: device.createComputePipeline({ label: "Deep frustum cull pipeline", layout: pipelineLayout, compute: { module, entryPoint: "cull" } }),
    indirectPipeline: device.createComputePipeline({ label: "Deep frustum indirect pipeline", layout: pipelineLayout, compute: { module, entryPoint: "writeIndirect" } }),
  };
  const sources = new Set<GpuCullingSharedInputs>(); let disposed = false;
  const context: GpuCullingPipelineContext = {
    createSharedInputs(capacity): GpuCullingSharedInputs {
      if (disposed) throw new Error("GPU culling pipeline context is disposed.");
      let source!: GpuCullingSharedInputs;
      source = createSharedInputs(kernel, capacity, () => sources.delete(source));
      sources.add(source); return source;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true; for (const source of [...sources]) source.dispose(); sources.clear();
    },
  };
  return context;
}

/** Standalone stable inputs. Packet caches should reuse createGpuCullingPipelineContext instead. */
export function createGpuCullingSharedInputs(device: GPUDevice, capacity: number): GpuCullingSharedInputs {
  const context = createGpuCullingPipelineContext(device);
  try {
    const source = context.createSharedInputs(capacity), dispose = source.dispose;
    source.dispose = (): void => { dispose(); context.dispose(); };
    return source;
  } catch (error) { context.dispose(); throw error; }
}

function createSharedInputs(kernel: GpuCullingKernel, capacity: number, onDispose: () => void): GpuCullingSharedInputs {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1_048_576) throw new Error("capacity must be an integer in 1..1048576");
  const { device, layout, cullPipeline, indirectPipeline, release } = kernel;
  const storage = (size: number, usage: GPUBufferUsageFlags, label: string): GPUBuffer => kernel.allocate({ label, size: Math.max(4, size), usage });
  const owned: GPUBuffer[] = [];
  const allocate = (size: number, usage: GPUBufferUsageFlags, label: string): GPUBuffer => {
    const buffer = storage(size, usage, label); owned.push(buffer); return buffer;
  };
  try {
    const input = allocate(capacity * GPU_CULL_INSTANCE_STRIDE, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "Deep culling input");
    const previous = allocate(capacity * GPU_CULL_PREVIOUS_TRANSFORM_STRIDE, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "Deep culling previous transforms");
    const bounds = allocate(capacity * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "Deep culling bounds");
    const params = allocate(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, "Deep culling parameters");
    const phases = new Set<GpuCullingPhaseResources>();
    let inputCount = 0; let disposed = false; let instancesReady = false;
    const assertAlive = (): void => { if (disposed) throw new Error("GPU culling resources are disposed."); };
    const writeInstances = (queue: GPUQueue, values: readonly CullingInstance[]): void => {
      assertAlive();
      if (values.length > capacity) throw new Error(`GPU culling input exceeds capacity ${capacity}.`);
      const packedInstances = packCullingInstances(values), packedPrevious = packPreviousTransforms(values), packedBounds = packBounds(values);
      instancesReady = false; inputCount = 0;
      queue.writeBuffer(input, 0, packedInstances); queue.writeBuffer(previous, 0, packedPrevious); queue.writeBuffer(bounds, 0, packedBounds);
      queue.writeBuffer(params, 0, new Uint32Array([values.length, capacity, 0, 0]));
      inputCount = values.length; instancesReady = true;
    };
    const createPhase = (indexCount = 6): GpuCullingPhaseResources => {
      assertAlive();
      if (!Number.isInteger(indexCount) || indexCount < 0 || indexCount > 0xffffffff) throw new Error("indexCount must be a nonnegative uint32");
      const phaseOwned: GPUBuffer[] = [];
      const allocatePhase = (size: number, usage: GPUBufferUsageFlags, label: string): GPUBuffer => {
        const buffer = storage(size, usage, label); phaseOwned.push(buffer); return buffer;
      };
      try {
        const compacted = allocatePhase(capacity * GPU_CULL_INSTANCE_STRIDE, GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC, "Deep culling compacted instances");
        const compactedPrevious = allocatePhase(capacity * GPU_CULL_PREVIOUS_TRANSFORM_STRIDE, GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC, "Deep culling compacted previous transforms");
        const frustum = allocatePhase(96, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "Deep culling frustum");
        const counter = allocatePhase(4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, "Deep culling counter");
        const indirect = allocatePhase(GPU_CULL_INDIRECT_STRIDE, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, "Deep culling indirect arguments");
        const bindGroup = device.createBindGroup({ label: "Deep frustum culling bindings", layout, entries: [input, bounds, compacted, frustum, counter, indirect, params, previous, compactedPrevious].map((buffer, binding) => ({ binding, resource: { buffer } })) });
        let phaseDisposed = false; let viewReady = false;
        const assertPhaseAlive = (): void => { assertAlive(); if (phaseDisposed) throw new Error("GPU culling phase resources are disposed."); };
        const phase: GpuCullingPhaseResources = {
          compacted, compactedPrevious, frustum, counter, indirect, cullPipeline, indirectPipeline, bindGroup, capacity, indexCount,
          writeView(queue, planes, args = {}): void {
            assertPhaseAlive();
            if (!instancesReady) throw new Error("GPU culling instances must be uploaded before the view.");
            const indirectArgs = packIndirectArgs(indexCount, args);
            viewReady = false;
            queue.writeBuffer(frustum, 0, packFrustum(planes)); queue.writeBuffer(counter, 0, new Uint32Array([0]));
            queue.writeBuffer(indirect, 0, indirectArgs); viewReady = true;
          },
          encode(encoder): void {
            assertPhaseAlive();
            if (!viewReady) throw new Error("GPU culling view must be prepared before encode.");
            viewReady = false;
            const pass = encoder.beginComputePass({ label: "Deep frustum culling" });
            try {
              pass.setBindGroup(0, bindGroup); pass.setPipeline(cullPipeline);
              if (inputCount) pass.dispatchWorkgroups(Math.ceil(inputCount / WORKGROUP_SIZE));
              pass.setPipeline(indirectPipeline); pass.dispatchWorkgroups(1);
            } catch (error) { failWithResourceCleanup(error, "Frustum culling encoding failed.", [() => pass.end()]); }
            pass.end();
          },
          dispose(): void {
            if (phaseDisposed) return;
            phaseDisposed = true; phases.delete(phase);
            for (const buffer of phaseOwned) release(buffer);
          },
        };
        phases.add(phase);
        return phase;
      } catch (error) {
        for (const buffer of phaseOwned) release(buffer);
        throw error;
      }
    };
    return {
      input, previous, bounds, params, capacity,
      get inputCount() { return inputCount; },
      writeInstances,
      createPhase,
      dispose(): void { if (disposed) return; disposed = true; for (const phase of [...phases]) phase.dispose(); for (const buffer of owned) release(buffer); onDispose(); },
    };
  } catch (error) { for (const buffer of owned) release(buffer); throw error; }
}

/** Compatibility facade for standalone callers that need one input set and one phase. */
export function createGpuFrustumCulling(device: GPUDevice, capacity: number, indexCount = 6): GpuCullingResources {
  const shared = createGpuCullingSharedInputs(device, capacity);
  try {
    const phase = shared.createPhase(indexCount);
    return {
      ...phase,
      input: shared.input, previous: shared.previous, bounds: shared.bounds, params: shared.params,
      get inputCount() { return shared.inputCount; },
      writeInstances: shared.writeInstances,
      writeInput(queue, values, planes, args = {}): void {
        shared.writeInstances(queue, values); phase.writeView(queue, planes, args);
      },
      dispose(): void { shared.dispose(); },
    };
  } catch (error) { shared.dispose(); throw error; }
}
