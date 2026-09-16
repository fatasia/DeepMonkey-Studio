import type { DeviceSession } from "./deviceSession.js";
import { failWithResourceCleanup, runResourceCleanup } from "./resourceCleanup.js";
import { GPU_DEFORMATION_HISTORY_WGSL } from "./gpuDeformationHistoryWgsl.js";
import { validateDeformationHistorySource, type GpuDeformationHistorySource,
  type GpuDeformationHistoryResult, type GpuDeformationHistoryStage } from "./gpuDeformationHistoryTypes.js";
export type { GpuDeformationHistorySource, GpuDeformationHistoryResult, GpuDeformationHistoryStage } from "./gpuDeformationHistoryTypes.js";

interface Allocation { readonly buffers: readonly [GPUBuffer, GPUBuffer] }
interface Committed { readonly allocation: Allocation; readonly slot: 0 | 1; readonly source: GpuDeformationHistorySource }
interface Pending extends Committed {
  readonly handle: GpuDeformationHistoryStage;
  readonly binding: GPUBindGroup | undefined;
  encoded: boolean;
}

/** One pose's submitted history. Call commit only after successful queue submission; discard cancelled encoders. */
export class GpuDeformationHistory {
  private committed: Committed | undefined;
  private pending: Pending | undefined;
  private disposed = false;
  private layout: GPUBindGroupLayout | undefined;
  private pipeline: GPUComputePipeline | undefined;

  constructor(private readonly session: DeviceSession) { this.assertReady(); }

  begin(input: GpuDeformationHistorySource): GpuDeformationHistoryStage {
    this.assertReady();
    if (this.pending) throw new Error("GPU deformation history already has a pending stage.");
    validateDeformationHistorySource(this.session.device, input);
    const source = Object.freeze({ ...input }), previous = this.committed;
    if (previous && source.sourceRevision < previous.source.sourceRevision) throw new Error("Stale deformation source revision.");
    const sameSource = previous?.source.sourceRevision === source.sourceRevision;
    if (sameSource && (source.output !== previous.source.output || source.outputStride !== previous.source.outputStride
      || source.vertexCount !== previous.source.vertexCount || Boolean(source.hasTangents) !== Boolean(previous.source.hasTangents))) {
      throw new Error("Deformation source changed without a source revision.");
    }
    if (sameSource && source.poseRevision < previous.source.poseRevision) throw new Error("Stale deformation pose revision.");
    const samePose = sameSource && source.poseRevision === previous.source.poseRevision;
    let allocation: Allocation | undefined;
    try {
      allocation = sameSource ? previous.allocation : this.allocate(source.vertexCount * 48);
      const slot: 0 | 1 = samePose ? previous.slot : sameSource && previous.slot === 0 ? 1 : 0;
      const current = allocation.buffers[slot];
      const result: GpuDeformationHistoryResult = Object.freeze({ current,
        previous: sameSource && !samePose ? previous.allocation.buffers[previous.slot] : current,
        vertexCount: source.vertexCount, outputStride: 48, sourceRevision: source.sourceRevision,
        poseRevision: source.poseRevision, hasTangents: source.outputStride === 48 && Boolean(source.hasTangents),
        historyValid: Boolean(sameSource), updated: !samePose });
      const binding = !samePose && source.outputStride === 32 ? this.conversionBinding(source, current) : undefined;
      const handle = Object.freeze({ result });
      this.pending = { allocation, slot, source, handle, binding, encoded: false };
      return handle;
    } catch (error) {
      failWithResourceCleanup(error, "Deformation history staging failed",
        allocation && allocation !== previous?.allocation ? [() => this.release(allocation!)] : []);
    }
  }

  encode(encoder: GPUCommandEncoder, stage: GpuDeformationHistoryStage): GpuDeformationHistoryResult {
    this.assertReady(); const pending = this.requirePending(stage);
    if (pending.encoded) throw new Error("Deformation history stage was already encoded.");
    try {
      if (stage.result.updated) {
        if (pending.source.outputStride === 48) {
          encoder.copyBufferToBuffer(pending.source.output, 0, stage.result.current, 0, pending.source.vertexCount * 48);
        } else {
          const pass = encoder.beginComputePass({ label: "Deep deformation history stride conversion" });
          try {
            pass.setPipeline(this.pipeline!); pass.setBindGroup(0, pending.binding!);
            pass.dispatchWorkgroups(Math.ceil(pending.source.vertexCount / 64));
          } catch (error) { failWithResourceCleanup(error, "Deformation history dispatch failed", [() => pass.end()]); }
          pass.end();
        }
      }
      pending.encoded = true; return stage.result;
    } catch (error) {
      failWithResourceCleanup(error, "Deformation history encoding failed", [() => { this.cancel(stage); }]);
    }
  }

  commit(stage: GpuDeformationHistoryStage): void {
    this.assertReady(); const pending = this.requirePending(stage);
    if (!pending.encoded) throw new Error("Cannot commit unencoded deformation history.");
    const previous = this.committed;
    this.committed = { allocation: pending.allocation, slot: pending.slot, source: pending.source };
    this.pending = undefined;
    if (previous && previous.allocation !== pending.allocation) this.release(previous.allocation);
  }

  cancel(stage: GpuDeformationHistoryStage): boolean {
    if (!this.pending) return false;
    const pending = this.requirePending(stage); this.pending = undefined;
    if (pending.allocation !== this.committed?.allocation) this.release(pending.allocation);
    return true;
  }

  dispose(): void { if (!this.disposed) { this.disposed = true; this.clear(); } }

  private requirePending(stage: GpuDeformationHistoryStage): Pending {
    if (!this.pending || this.pending.handle !== stage) throw new Error("Unknown or completed deformation history stage.");
    return this.pending;
  }

  private allocate(size: number): Allocation {
    const buffers: GPUBuffer[] = [];
    try {
      for (let slot = 0; slot < 2; slot++) buffers.push(this.session.own(this.session.device.createBuffer({
        label: `Deep deformation history ${slot}`, size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      })));
      return { buffers: [buffers[0]!, buffers[1]!] };
    } catch (error) {
      failWithResourceCleanup(error, "Deformation history allocation failed", buffers.map(buffer => () => this.session.release(buffer)));
    }
  }

  private conversionBinding(source: GpuDeformationHistorySource, destination: GPUBuffer): GPUBindGroup {
    const device = this.session.device;
    if (!this.pipeline) {
      const module = device.createShaderModule({ label: "Deep deformation history conversion", code: GPU_DEFORMATION_HISTORY_WGSL });
      const layout = device.createBindGroupLayout({ entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ] });
      const pipeline = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint: "expandSkinVertices" } });
      this.layout = layout; this.pipeline = pipeline;
    }
    return device.createBindGroup({ layout: this.layout!, entries: [
      { binding: 0, resource: { buffer: source.output, size: source.vertexCount * 32 } },
      { binding: 1, resource: { buffer: destination, size: source.vertexCount * 48 } },
    ] });
  }

  private release(allocation: Allocation): void {
    runResourceCleanup("Deformation history resource cleanup failed", allocation.buffers.map(buffer => () => this.session.release(buffer)));
  }

  private clear(): void {
    const previous = this.committed, pending = this.pending; this.committed = undefined; this.pending = undefined;
    runResourceCleanup("Deformation history cleanup failed", [
      ...(pending && pending.allocation !== previous?.allocation ? [() => this.release(pending.allocation)] : []),
      ...(previous ? [() => this.release(previous.allocation)] : []),
    ]);
  }

  private assertReady(): void {
    if (this.disposed) throw new Error("GPU deformation history is disposed.");
    if (this.session.state !== "ready") {
      failWithResourceCleanup(new Error("GPU session is not ready for deformation history"), "Deformation history device loss", [() => this.clear()]);
    }
  }
}
