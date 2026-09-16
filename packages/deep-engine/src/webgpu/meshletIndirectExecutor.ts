/// <reference types="@webgpu/types" />
import type { DeviceSession } from "./deviceSession.js";
import { failWithResourceCleanup, runResourceCleanup } from "./resourceCleanup.js";
import { MESHLET_INDIRECT_WGSL } from "./meshletIndirectWgsl.js";
import { validateMeshletIndirect } from "./meshletIndirectValidation.js";
import { buildMeshletRenderBundle, sameBundleSnapshot, validateMeshletRenderBundleRequest,
  type MeshletBundleSnapshot } from "./meshletRenderBundle.js";
import {
  MESHLET_DRAW_INDEXED_INDIRECT_STRIDE,
  MESHLET_INDIRECT_PARAMETER_SIZE,
  type MeshletBundleExecution,
  type MeshletIndirectOptions,
  type MeshletIndirectPlan,
  type MeshletRenderBundleRequest,
  type ValidatedMeshletIndirect,
} from "./meshletIndirectTypes.js";

interface IndirectResources {
  readonly capacity: number;
  readonly commands: GPUBuffer;
  readonly parameters: GPUBuffer;
  sourceRecords: GPUBuffer;
  sourceCount: GPUBuffer;
  bindGroup: GPUBindGroup;
}

interface LastPlan {
  readonly source: ValidatedMeshletIndirect["source"];
  readonly request: ValidatedMeshletIndirect;
  readonly plan: MeshletIndirectPlan;
}

interface BundleCache extends MeshletBundleSnapshot { readonly bundle: GPURenderBundle }

/** Converts stable visible records to fixed-capacity indirect commands and executes a cached RenderBundle. */
export class MeshletIndirectExecutor {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private resources: IndirectResources | undefined;
  private last: LastPlan | undefined;
  private bundleCache: BundleCache | undefined;
  private generation = 0;
  private disposed = false;

  constructor(private readonly session: DeviceSession) {
    if (session.state !== "ready") throw new Error("GPU session is not ready for meshlet indirect execution.");
    const device = session.device, module = device.createShaderModule({ label: "Deep meshlet indirect WGSL", code: MESHLET_INDIRECT_WGSL });
    this.layout = device.createBindGroupLayout({ label: "Deep meshlet indirect layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
    ] });
    const pipelineLayout = device.createPipelineLayout({ label: "Deep meshlet indirect pipeline layout", bindGroupLayouts: [this.layout] });
    this.pipeline = device.createComputePipeline({ label: "Deep meshlet indirect command pipeline", layout: pipelineLayout,
      compute: { module, entryPoint: "writeCommands" } });
  }

  encode(encoder: GPUCommandEncoder, source: ValidatedMeshletIndirect["source"], options: MeshletIndirectOptions): MeshletIndirectPlan {
    this.assertReady();
    const request = validateMeshletIndirect(this.session.device, source, options);
    if (this.last && exactPlan(this.last, request) && (this.last.source === source || !source.updated)) {
      return Object.freeze({ ...this.last.plan, updated: false });
    }
    const previous = this.resources, reusable = previous?.capacity === source.capacity;
    let candidate: IndirectResources | undefined;
    let published = false;
    try {
      candidate = reusable ? previous : this.allocate(source);
      if (candidate.sourceRecords !== source.visibleRecords || candidate.sourceCount !== source.visibleCount) {
        candidate = this.rebind(candidate, source);
      }
      this.writeParameters(candidate.parameters, request);
      const pass = encoder.beginComputePass({ label: "Deep meshlet indirect command generation" });
      try {
        pass.setPipeline(this.pipeline); pass.setBindGroup(0, candidate.bindGroup);
        pass.dispatchWorkgroups(request.workgroups);
      } catch (error) {
        failWithResourceCleanup(error, "Meshlet indirect encoding failed.", [() => pass.end()]);
      }
      pass.end();
      if (!reusable) {
        this.generation += 1; this.bundleCache = undefined;
      }
      const plan: MeshletIndirectPlan = Object.freeze({ commands: candidate.commands, capacity: candidate.capacity,
        inputMeshletCount: source.inputCount, expandedIndexCount: request.expandedIndexCount,
        firstIndexBase: request.firstIndexBase, baseVertex: request.baseVertex, baseInstance: request.baseInstance,
        instanceMapping: request.instanceMapping, commandStride: MESHLET_DRAW_INDEXED_INDIRECT_STRIDE,
        generation: this.generation, updated: true });
      this.resources = candidate;
      published = true;
      if (previous && previous.commands !== candidate.commands) this.release(previous);
      this.last = { source, request, plan };
      return plan;
    } catch (error) {
      this.last = undefined; this.bundleCache = undefined;
      // 退休失败不销毁已发布替代资源；调用方可丢弃 encoder，重试必须重新编码。
      if (published) throw error;
      this.resources = undefined;
      const retired = new Set([candidate, previous].filter((value): value is IndirectResources => Boolean(value)));
      const buffers = new Set([...retired].flatMap(value => [value.commands, value.parameters]));
      failWithResourceCleanup(error, "Meshlet indirect preparation failed.",
        [...buffers].map(value => () => this.session.release(value)));
    }
  }

  prepareBundle(plan: MeshletIndirectPlan, request: MeshletRenderBundleRequest): MeshletBundleExecution {
    this.assertReady(); this.validateCurrentPlan(plan);
    validateMeshletRenderBundleRequest(this.session.device, plan, request);
    if (this.bundleCache && sameBundleSnapshot(this.bundleCache, plan.commands, request)) {
      return Object.freeze({ bundle: this.bundleCache.bundle, drawCount: plan.capacity, reused: true });
    }
    const bundle = buildMeshletRenderBundle(this.session.device, plan, request);
    this.bundleCache = { bundle, commands: plan.commands, request: snapshotRequest(request) };
    return Object.freeze({ bundle, drawCount: plan.capacity, reused: false });
  }

  execute(pass: GPURenderPassEncoder, plan: MeshletIndirectPlan,
    request: MeshletRenderBundleRequest): MeshletBundleExecution {
    const execution = this.prepareBundle(plan, request);
    pass.executeBundles([execution.bundle]);
    return execution;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.last = undefined; this.bundleCache = undefined; this.releaseOutputs();
  }

  private allocate(source: ValidatedMeshletIndirect["source"]): IndirectResources {
    const created: GPUBuffer[] = [], device = this.session.device;
    const buffer = (label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer => {
      const value = this.session.own(device.createBuffer({ label, size, usage })); created.push(value); return value;
    };
    try {
      const base = { capacity: source.capacity,
        commands: buffer("Deep meshlet indirect commands", source.capacity * MESHLET_DRAW_INDEXED_INDIRECT_STRIDE,
          GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC),
        parameters: buffer("Deep meshlet indirect parameters", MESHLET_INDIRECT_PARAMETER_SIZE,
          GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST) };
      const bindGroup = this.createBinding(base, source);
      return { ...base, sourceRecords: source.visibleRecords, sourceCount: source.visibleCount, bindGroup };
    } catch (error) {
      failWithResourceCleanup(error, "Meshlet indirect allocation failed.",
        created.map(value => () => this.session.release(value)));
    }
  }

  private rebind(resources: IndirectResources, source: ValidatedMeshletIndirect["source"]): IndirectResources {
    return { ...resources, sourceRecords: source.visibleRecords, sourceCount: source.visibleCount,
      bindGroup: this.createBinding(resources, source) };
  }

  private createBinding(resources: Pick<IndirectResources, "commands" | "parameters">,
    source: ValidatedMeshletIndirect["source"]): GPUBindGroup {
    return this.session.device.createBindGroup({ label: "Deep meshlet indirect bindings", layout: this.layout, entries: [
      { binding: 0, resource: { buffer: source.visibleRecords } }, { binding: 1, resource: { buffer: source.visibleCount } },
      { binding: 2, resource: { buffer: resources.commands } }, { binding: 3, resource: { buffer: resources.parameters } },
    ] });
  }

  private writeParameters(buffer: GPUBuffer, request: ValidatedMeshletIndirect): void {
    const values = new Uint32Array(8);
    values.set([request.source.capacity, request.source.capacity, request.expandedIndexCount, request.firstIndexBase,
      request.baseVertex >>> 0, request.baseInstance, request.mappingCode, request.source.inputCount]);
    this.session.device.queue.writeBuffer(buffer, 0, values);
  }

  private validateCurrentPlan(plan: MeshletIndirectPlan): void {
    const current = this.last?.plan;
    if (!this.resources || !current || plan.commands !== this.resources.commands || plan.capacity !== this.resources.capacity
      || plan.generation !== this.generation || !samePlan(plan, current)) {
      throw new Error("Meshlet indirect plan is stale or belongs to another executor.");
    }
  }

  private assertReady(): void {
    if (this.disposed) throw new Error("Meshlet indirect executor is disposed.");
    if (this.session.state !== "ready") {
      this.last = undefined; this.bundleCache = undefined;
      failWithResourceCleanup(new Error("GPU session is not ready for meshlet indirect execution."),
        "Meshlet indirect device loss cleanup failed.", [() => this.releaseOutputs()]);
    }
  }

  private releaseOutputs(): void {
    const previous = this.resources; this.resources = undefined;
    if (previous) this.release(previous);
  }
  private release(resources: IndirectResources): void {
    runResourceCleanup("Meshlet indirect output cleanup failed.",
      [() => this.session.release(resources.commands), () => this.session.release(resources.parameters)]);
  }
}

function exactPlan(last: LastPlan, request: ValidatedMeshletIndirect): boolean {
  const before = last.request;
  return before.source.visibleRecords === request.source.visibleRecords && before.source.visibleCount === request.source.visibleCount
    && before.source.capacity === request.source.capacity && before.source.inputCount === request.source.inputCount
    && before.expandedIndexCount === request.expandedIndexCount && before.firstIndexBase === request.firstIndexBase
    && before.baseVertex === request.baseVertex && before.baseInstance === request.baseInstance
    && before.instanceMapping === request.instanceMapping;
}

function samePlan(left: MeshletIndirectPlan, right: MeshletIndirectPlan): boolean {
  return left.commands === right.commands && left.capacity === right.capacity && left.inputMeshletCount === right.inputMeshletCount
    && left.expandedIndexCount === right.expandedIndexCount && left.firstIndexBase === right.firstIndexBase
    && left.baseVertex === right.baseVertex && left.baseInstance === right.baseInstance
    && left.instanceMapping === right.instanceMapping && left.commandStride === right.commandStride
    && left.generation === right.generation;
}

function snapshotRequest(request: MeshletRenderBundleRequest): MeshletRenderBundleRequest {
  return Object.freeze({ ...request, colorFormats: Object.freeze([...request.colorFormats]),
    ...(request.vertexBuffers ? { vertexBuffers: Object.freeze(request.vertexBuffers.map(value => Object.freeze({ ...value }))) } : {}),
    ...(request.bindGroups ? { bindGroups: Object.freeze(request.bindGroups.map(value => Object.freeze({ ...value,
      ...(value.dynamicOffsets ? { dynamicOffsets: Object.freeze([...value.dynamicOffsets]) } : {}) }))) } : {}) });
}

export { MESHLET_INDIRECT_WGSL } from "./meshletIndirectWgsl.js";
export * from "./meshletIndirectTypes.js";
