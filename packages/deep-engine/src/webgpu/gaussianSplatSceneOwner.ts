import type { SplatCloud } from "../gaussianSplat/decodeSplatPly.js";
import { assertSplatFrameBudget, SPLAT_UNIFORM_BYTE_LENGTH, SPLAT_UNIFORM_FLOAT_COUNT,
  writeSplatUniforms, type SplatFrameUniforms } from "../gaussianSplat/splatGpuResources.js";
import { sortSplatIndicesByDepth } from "../gaussianSplat/sortSplatsByDepth.js";
import type { DeviceSession } from "./deviceSession.js";
import { gpuValidatedStage } from "./gpuValidatedStage.js";
import { GaussianSplatPass } from "./gaussianSplatPass.js";

export type SplatStageResult = "staged" | "cancelled" | "superseded";
export interface SplatRenderStatus {
  readonly splatCount: number;
  readonly sourceShDegree: number;
  readonly renderedShDegree: 0;
  readonly shFallbackReason?: "higher-order-sh-stored-dc-rendered";
  readonly generation: number;
  readonly recordBytes: number;
  readonly orderUploads: number;
  readonly sortCount: number;
}
interface Candidate {
  readonly records: Float32Array<ArrayBuffer>;
  readonly buffers: readonly GPUBuffer[];
  readonly group: GPUBindGroup;
  readonly status: Omit<SplatRenderStatus, "orderUploads" | "sortCount">;
  previousView: number[] | undefined;
  orderUploads: number;
  sortCount: number;
}
/** One live cloud and at most one allocating candidate; no global cache or borrowed GPU buffers. */
export class GaussianSplatSceneOwner {
  private readonly device: GPUDevice;
  private readonly uniformData = new Float32Array(SPLAT_UNIFORM_FLOAT_COUNT);
  private pass: GaussianSplatPass | undefined;
  private active: Candidate | undefined;
  private serial: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private disposed = false;
  constructor(private readonly session: DeviceSession, private readonly color: GPUTextureFormat,
    private readonly depth: GPUTextureFormat, private readonly reactive: boolean) { this.device = session.device; }
  get current(): SplatRenderStatus | undefined {
    if (!this.active || this.disposed || this.device !== this.session.device) return undefined;
    return Object.freeze({ ...this.active.status, orderUploads: this.active.orderUploads, sortCount: this.active.sortCount });
  }
  stage(cloud: SplatCloud, signal?: AbortSignal): Promise<SplatStageResult> {
    this.assertReady(); const generation = ++this.generation;
    const operation = this.serial.catch(() => undefined).then(async (): Promise<SplatStageResult> => {
      if (signal?.aborted) return "cancelled";
      if (generation !== this.generation || this.disposed) return "superseded";
      this.assertReady();
      const count = cloud.splatCount, sourceShDegree = cloud.shDegree;
      assertSplatFrameBudget(count);
      if (![0, 1, 2, 3].includes(sourceShDegree) || cloud.records.length !== count * 16) throw new RangeError("Gaussian splat record length and SH degree must match the contract.");
      const bytes = Math.max(64, cloud.records.byteLength), orderBytes = Math.max(4, count * 4);
      if (bytes > this.device.limits.maxStorageBufferBindingSize || bytes > this.device.limits.maxBufferSize
        || orderBytes > this.device.limits.maxStorageBufferBindingSize) throw new RangeError("Gaussian splat cloud exceeds the device storage budget.");
      // Freeze the staged CPU data once: subsequent caller mutation cannot drift GPU records and sorting.
      const records = new Float32Array(cloud.records);
      this.validateRecords(records, count);
      const buffers: GPUBuffer[] = [];
      let candidate: Candidate | undefined;
      try {
        const staged = gpuValidatedStage(this.device, () => {
          const pass = this.pass ?? new GaussianSplatPass(this.session, this.color, this.depth, this.reactive);
          const descriptors: GPUBufferDescriptor[] = [
            { label: "Deep Gaussian records", size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST },
            { label: "Deep Gaussian order", size: orderBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST },
            { label: "Deep Gaussian frame", size: SPLAT_UNIFORM_BYTE_LENGTH, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST },
          ];
          for (const descriptor of descriptors) {
            this.session.assertResourceAdmission(descriptor);
            buffers.push(this.session.own(this.device.createBuffer(descriptor)));
          }
          if (records.byteLength) this.device.queue.writeBuffer(buffers[0]!, 0, records);
          const group = this.device.createBindGroup({ label: "Deep Gaussian cloud bindings", layout: pass.layout,
            entries: [buffers[2]!, buffers[0]!, buffers[1]!].map((buffer, binding) => ({ binding, resource: { buffer } })) });
          return { pass, group };
        }, "Gaussian splat candidate validation failed");
        await staged.checked; this.assertReady();
        if (signal?.aborted) return "cancelled";
        if (generation !== this.generation) return "superseded";
        candidate = { records, buffers, group: staged.value.group, previousView: undefined, orderUploads: 0, sortCount: 0,
          status: { splatCount: count, sourceShDegree, renderedShDegree: 0,
            ...(sourceShDegree ? { shFallbackReason: "higher-order-sh-stored-dc-rendered" as const } : {}),
            generation, recordBytes: records.byteLength } };
        const previous = this.active; this.active = candidate; this.pass = staged.value.pass;
        if (previous) this.retire(previous); return "staged";
      } finally {
        if (!candidate) for (const buffer of buffers) this.session.release(buffer);
      }
    });
    this.serial = operation; return operation;
  }
  encode(input: { encoder: GPUCommandEncoder; color: GPUTextureView; depth: GPUTextureView;
    frame: Omit<SplatFrameUniforms, "splatCount">; reactiveView?: GPUTextureView; clearReactive?: boolean }): number {
    this.assertReady(); const active = this.active;
    if (!active || active.status.splatCount === 0) return 0;
    const frame = input.frame;
    this.validateFrame(frame);
    const changed = !active.previousView || active.previousView.some((value, index) => value !== frame.viewMatrix[index]);
    if (changed) {
      const order = sortSplatIndicesByDepth(active.records, active.status.splatCount, frame.viewMatrix);
      this.device.queue.writeBuffer(active.buffers[1]!, 0, order as Uint32Array<ArrayBuffer>);
      active.previousView = Array.from({ length: 16 }, (_, index) => frame.viewMatrix[index]!);
      active.orderUploads++; active.sortCount++;
    }
    writeSplatUniforms(this.uniformData, { ...frame, splatCount: active.status.splatCount });
    this.device.queue.writeBuffer(active.buffers[2]!, 0, this.uniformData);
    this.pass!.encode(input.encoder, input.color, input.depth, active.group, active.status.splatCount,
      input.reactiveView, input.clearReactive);
    return active.status.splatCount;
  }
  clear(): void { this.assertReady(); ++this.generation; const previous = this.active; this.active = undefined; if (previous) this.retire(previous); }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; ++this.generation;
    const previous = this.active; this.active = undefined; if (previous) this.retire(previous);
  }
  private retire(candidate: Candidate): void {
    const release = () => { for (const buffer of candidate.buffers) this.session.release(buffer); };
    void this.device.queue.onSubmittedWorkDone().then(release, release);
  }
  private assertReady(): void {
    if (this.disposed || this.session.device !== this.device || !["ready", "degraded"].includes(this.session.state)) {
      throw new Error("Gaussian splat device epoch is no longer current.");
    }
  }
  private validateRecords(records: Float32Array, count: number): void {
    for (let index = 0; index < count; index++) {
      const base = index * 16;
      for (let field = 0; field < 16; field++) if (!Number.isFinite(records[base + field])) throw new RangeError(`Gaussian splat ${index} field ${field} is not finite.`);
      const opacity = records[base + 3]!;
      let invalid = records[base + 4]! <= 0 || records[base + 5]! <= 0 || records[base + 6]! <= 0
        || Math.hypot(records[base + 8]!, records[base + 9]!, records[base + 10]!, records[base + 11]!) < 1e-12
        || opacity < 0 || opacity > 1;
      for (let field = 12; field < 16; field++) invalid ||= records[base + field]! < 0 || records[base + field]! > 1;
      if (invalid) {
        throw new RangeError(`Gaussian splat ${index} scale, rotation or color is invalid.`);
      }
    }
  }
  private validateFrame(frame: Omit<SplatFrameUniforms, "splatCount">): void {
    if (frame.viewMatrix.length !== 16 || frame.viewProjectionMatrix.length !== 16
      || [...Array.from(frame.viewMatrix), ...Array.from(frame.viewProjectionMatrix), ...frame.cameraPosition,
        ...frame.viewportPixels, ...frame.focalPixels].some(value => !Number.isFinite(value))
      || [...frame.viewportPixels, ...frame.focalPixels, frame.near ?? .1].some(value => !Number.isFinite(value) || value <= 0)) throw new RangeError("Gaussian splat frame matrices and extent must be finite and valid.");
  }
}
