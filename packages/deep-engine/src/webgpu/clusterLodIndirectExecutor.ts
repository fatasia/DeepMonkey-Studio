/// <reference types="@webgpu/types" />
import type { DeviceSession } from "./deviceSession.js";
import { CLUSTER_LOD_INDIRECT_COMMAND_STRIDE_BYTES, type ClusterLodIndirectPlan } from "../rayTracing/clusterLodIndirectPlan.js";

const MAX_CLUSTER_LOD_DRAWS = 65_536;

export interface ClusterLodGeometryBuffers {
  readonly indexBuffer: GPUBuffer;
  readonly vertexBuffer: GPUBuffer;
  readonly indexSize: number;
  readonly vertexSize: number;
}

export interface ClusterLodRenderRequest {
  readonly pipeline: GPURenderPipeline;
  readonly colorFormats: readonly (GPUTextureFormat | null)[];
  readonly depthStencilFormat?: GPUTextureFormat;
  readonly sampleCount?: number;
  readonly bindGroups?: readonly { readonly index: number; readonly bindGroup: GPUBindGroup; readonly dynamicOffsets?: readonly number[] }[];
}

export interface ClusterLodExecutionPlan {
  readonly commands: GPUBuffer;
  readonly drawCount: number;
  readonly commandStride: typeof CLUSTER_LOD_INDIRECT_COMMAND_STRIDE_BYTES;
  readonly generation: number;
  readonly updated: boolean;
}

export interface ClusterLodBundleExecution {
  readonly bundle: GPURenderBundle;
  readonly drawCount: number;
  readonly reused: boolean;
}

interface BundleSnapshot {
  readonly commands: GPUBuffer;
  readonly plan: ClusterLodExecutionPlan;
  readonly request: ClusterLodRenderRequest;
  readonly geometry: ClusterLodGeometryBuffers;
  readonly bundle: GPURenderBundle;
}

/** 将已有 cluster LOD 选层与 indirect 合同接入 WebGPU；选层仍由既有 kernel/CPU 合同提供。 */
export class ClusterLodIndirectExecutor {
  private commands: GPUBuffer | undefined;
  private generation = 0;
  private lastSignature: string | undefined;
  private lastPlan: ClusterLodExecutionPlan | undefined;
  private bundle: BundleSnapshot | undefined;
  private disposed = false;
  private requiredIndexCount = 0;

  constructor(private readonly session: DeviceSession) {
    this.assertReady();
  }

  encode(plan: ClusterLodIndirectPlan): ClusterLodExecutionPlan {
    this.assertReady();
    validatePlan(plan, this.session.device);
    const signature = planSignature(plan);
    if (this.commands && this.lastPlan && this.lastSignature === signature) {
      return Object.freeze({ ...this.lastPlan, updated: false });
    }
    const previous = this.commands;
    const size = Math.max(4, plan.commandsByteLength);
    const next = this.session.own(this.session.device.createBuffer({
      label: "Deep cluster LOD indirect commands",
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
    }));
    try {
      const words = new Uint32Array(size / 4);
      plan.draws.forEach((draw, index) => words.set(draw.indirectCommand, index * 5));
      this.session.device.queue.writeBuffer(next, 0, words);
      this.commands = next;
      this.generation += 1;
      this.lastSignature = signature;
      this.requiredIndexCount = plan.draws.reduce((count, draw) =>
        Math.max(count, draw.indirectCommand[2] + draw.indirectCommand[0]), 0);
      this.bundle = undefined;
      const result = Object.freeze({ commands: next, drawCount: plan.drawCount,
        commandStride: CLUSTER_LOD_INDIRECT_COMMAND_STRIDE_BYTES, generation: this.generation, updated: true as const });
      this.lastPlan = result;
      if (previous) this.session.release(previous);
      return result;
    } catch (error) {
      this.session.release(next);
      throw new Error(`Cluster LOD indirect command upload failed: ${String(error)}`);
    }
  }

  prepareBundle(execution: ClusterLodExecutionPlan, geometry: ClusterLodGeometryBuffers,
    request: ClusterLodRenderRequest): ClusterLodBundleExecution {
    this.assertReady();
    if (!execution || !this.lastPlan || execution.commands !== this.commands || execution.generation !== this.generation
      || execution.drawCount !== this.lastPlan.drawCount || execution.commandStride !== this.lastPlan.commandStride) {
      throw new Error("Cluster LOD indirect execution plan is stale or belongs to another executor.");
    }
    validateGeometry(geometry, this.session.device);
    if (this.requiredIndexCount > geometry.indexSize / 4) {
      throw new Error("Cluster LOD indirect commands exceed the index geometry range.");
    }
    validateRequest(request, this.session.device);
    if (this.bundle && sameBundle(this.bundle, execution, geometry, request)) {
      return Object.freeze({ bundle: this.bundle.bundle, drawCount: execution.drawCount, reused: true });
    }
    const encoder = this.session.device.createRenderBundleEncoder({
      label: "Deep cluster LOD indirect bundle", colorFormats: request.colorFormats,
      ...(request.depthStencilFormat ? { depthStencilFormat: request.depthStencilFormat } : {}),
      ...(request.sampleCount !== undefined ? { sampleCount: request.sampleCount } : {}),
    });
    encoder.setPipeline(request.pipeline);
    for (const binding of request.bindGroups ?? []) {
      if (binding.dynamicOffsets) encoder.setBindGroup(binding.index, binding.bindGroup, binding.dynamicOffsets);
      else encoder.setBindGroup(binding.index, binding.bindGroup);
    }
    encoder.setVertexBuffer(0, geometry.vertexBuffer, 0, geometry.vertexSize);
    encoder.setIndexBuffer(geometry.indexBuffer, "uint32", 0, geometry.indexSize);
    for (let index = 0; index < execution.drawCount; index += 1) {
      encoder.drawIndexedIndirect(execution.commands, index * CLUSTER_LOD_INDIRECT_COMMAND_STRIDE_BYTES);
    }
    const bundle = encoder.finish({ label: "Deep cluster LOD indirect bundle" });
    // 保存值快照，避免调用方原地修改数组后误复用旧 bundle。
    this.bundle = { commands: execution.commands, plan: execution, geometry: { ...geometry }, bundle,
      request: { ...request, colorFormats: [...request.colorFormats],
        ...(request.bindGroups ? { bindGroups: request.bindGroups.map(binding => ({ ...binding,
          ...(binding.dynamicOffsets ? { dynamicOffsets: [...binding.dynamicOffsets] } : {}) })) } : {}) } };
    return Object.freeze({ bundle, drawCount: execution.drawCount, reused: false });
  }

  execute(pass: GPURenderPassEncoder, execution: ClusterLodExecutionPlan,
    geometry: ClusterLodGeometryBuffers, request: ClusterLodRenderRequest): ClusterLodBundleExecution {
    const result = this.prepareBundle(execution, geometry, request);
    pass.executeBundles([result.bundle]);
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.bundle = undefined;
    this.lastPlan = undefined;
    this.lastSignature = undefined;
    const commands = this.commands;
    this.commands = undefined;
    if (commands) this.session.release(commands);
  }

  private assertReady(): void {
    if (this.disposed) throw new Error("Cluster LOD indirect executor is disposed.");
    if (this.session.state !== "ready") {
      this.dispose();
      throw new Error("GPU session is not ready for cluster LOD indirect execution.");
    }
  }
}

function validatePlan(plan: ClusterLodIndirectPlan, device: GPUDevice): void {
  if (!plan || !Array.isArray(plan.draws) || !Number.isSafeInteger(plan.drawCount) || plan.drawCount < 0
    || plan.drawCount !== plan.draws.length
    || plan.commandsByteLength !== plan.drawCount * CLUSTER_LOD_INDIRECT_COMMAND_STRIDE_BYTES) {
    throw new Error("Cluster LOD indirect plan has inconsistent draw metadata.");
  }
  if (plan.drawCount > MAX_CLUSTER_LOD_DRAWS) throw new Error("Cluster LOD indirect plan exceeds the draw budget.");
  for (const draw of plan.draws) {
    const command = draw?.indirectCommand;
    if (!Array.isArray(command) || command.length !== 5) {
      throw new Error("Cluster LOD indirect plan contains an invalid command record.");
    }
    // baseVertex 在 GPU 中为 i32；上游合同以非负顶点基址传入，不能溢出成负值。
    for (let index = 0; index < 5; index += 1) {
      const value = command[index];
      if (!Number.isInteger(value) || value < 0 || value > (index === 3 ? 0x7fffffff : 0xffffffff)) {
        throw new Error("Cluster LOD indirect plan contains an invalid command word.");
      }
    }
    if (command[4] !== 0 && !device.features.has("indirect-first-instance")) {
      throw new Error("Cluster LOD indirect firstInstance requires indirect-first-instance.");
    }
  }
  if (Math.max(4, plan.commandsByteLength) > device.limits.maxBufferSize) {
    throw new Error("Cluster LOD indirect plan exceeds GPU maxBufferSize.");
  }
}

function validateGeometry(geometry: ClusterLodGeometryBuffers, device: GPUDevice): void {
  if (!geometry) throw new Error("Invalid cluster LOD geometry buffers.");
  for (const [buffer, usage, size, label] of [[geometry.indexBuffer, GPUBufferUsage.INDEX, geometry.indexSize, "index"],
    [geometry.vertexBuffer, GPUBufferUsage.VERTEX, geometry.vertexSize, "vertex"]] as const) {
    if (!buffer || (buffer.usage & usage) === 0 || !Number.isSafeInteger(size) || size < 4 || size % 4 !== 0 || size > buffer.size) {
      throw new Error(`Invalid cluster LOD ${label} geometry buffer.`);
    }
    if (size > device.limits.maxBufferSize) throw new Error(`Cluster LOD ${label} geometry exceeds GPU maxBufferSize.`);
  }
}

function validateRequest(request: ClusterLodRenderRequest, device: GPUDevice): void {
  if (!request || !request.pipeline || !Array.isArray(request.colorFormats) || request.colorFormats.length > device.limits.maxColorAttachments) {
    throw new Error("Invalid cluster LOD render request.");
  }
  const sampleCount = request.sampleCount ?? 1;
  if (sampleCount !== 1 && sampleCount !== 4) throw new Error("Cluster LOD render request sampleCount must be 1 or 4.");
  if (request.bindGroups !== undefined && !Array.isArray(request.bindGroups)) {
    throw new Error("Invalid cluster LOD bind groups.");
  }
  const indices = new Set<number>();
  for (const binding of request.bindGroups ?? []) {
    if (!binding || !binding.bindGroup || !Number.isInteger(binding.index) || binding.index < 0
      || binding.index >= device.limits.maxBindGroups || indices.has(binding.index)) {
      throw new Error("Invalid cluster LOD bind group index or resource.");
    }
    indices.add(binding.index);
    if (binding.dynamicOffsets !== undefined) {
      if (!Array.isArray(binding.dynamicOffsets)) throw new Error("Invalid cluster LOD dynamic offsets.");
      for (const offset of binding.dynamicOffsets) {
        if (!Number.isInteger(offset) || offset < 0 || offset > 0xffffffff) {
          throw new Error("Invalid cluster LOD dynamic offset.");
        }
      }
    }
  }
}

function planSignature(plan: ClusterLodIndirectPlan): string {
  return plan.draws.map(draw => draw.indirectCommand.join(",")).join(";");
}

function sameBundle(snapshot: BundleSnapshot, plan: ClusterLodExecutionPlan,
  geometry: ClusterLodGeometryBuffers, request: ClusterLodRenderRequest): boolean {
  return snapshot.commands === plan.commands && snapshot.plan.generation === plan.generation
    && snapshot.geometry.indexBuffer === geometry.indexBuffer && snapshot.geometry.vertexBuffer === geometry.vertexBuffer
    && snapshot.geometry.indexSize === geometry.indexSize && snapshot.geometry.vertexSize === geometry.vertexSize
    && snapshot.request.pipeline === request.pipeline && sameValues(snapshot.request.colorFormats, request.colorFormats)
    && snapshot.request.depthStencilFormat === request.depthStencilFormat
    && snapshot.request.sampleCount === request.sampleCount && sameBindings(snapshot.request.bindGroups, request.bindGroups);
}

function sameValues(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameBindings(left: ClusterLodRenderRequest["bindGroups"], right: ClusterLodRenderRequest["bindGroups"]): boolean {
  const a = left ?? [], b = right ?? [];
  return a.length === b.length && a.every((value, index) => value.index === b[index]!.index
    && value.bindGroup === b[index]!.bindGroup && sameValues(value.dynamicOffsets ?? [], b[index]!.dynamicOffsets ?? []));
}

export { MAX_CLUSTER_LOD_DRAWS };
