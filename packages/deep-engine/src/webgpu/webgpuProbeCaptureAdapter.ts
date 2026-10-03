/// <reference types="@webgpu/types" />
import type {
  ProbeCaptureAdapter, ProbeCaptureBeginContext, ProbeCaptureTransaction,
} from "../lighting/probeClipmapCaptureExecutor.js";
import type { ProbeClipmapPlan, ProbeVector3 } from "../lighting/probeClipmapPlan.js";
import { packProbeLevels, packProbeUpdates, sameProbeLevels } from "../lighting/probeClipmapResourceData.js";
import { WebGpuProbeMomentsPipeline, probeMomentsVolumeSize } from "./webgpuProbeMoments.js";
import { PROBE_RADIANCE_MOMENT_LANES } from "../rayTracing/probeRadianceKernel.js";
import { DEEP_GI_TEXTURE_LEVEL_METADATA_BYTES } from "../lighting/probeClipmapTextureSamplingWgsl.js";
import type { DeviceSession } from "./deviceSession.js";
import { gpuValidatedStage } from "./gpuValidatedStage.js";
import { runResourceCleanup } from "./resourceCleanup.js";
import { WebGpuProbeCapturePool, type ProbeVolume } from "./webgpuProbeCapturePool.js";
import {
  WEBGPU_PROBE_CAPTURE_WGSL, WEBGPU_PROBE_CAPTURE_WORKGROUP, WEBGPU_PROBE_VOLUME_WORKGROUP,
} from "./webgpuProbeCaptureWgsl.js";
import {
  assertProbeUpdate, positiveProbeInteger, probeAbortError, probeMipSize,
  packProbeCaptureUniform, validateProbeEnergyClamp,
  probeSampledTextureLayout, probeStorageLayout, probeStorageTextureLayout, probeUniformLayout,
  validateProbeHysteresis, validateProbeRadiance, validateProbeVolume,
  WEBGPU_PROBE_UNIFORM_BYTES, WEBGPU_PROBE_VOLUME_FORMAT,
  type WebGpuProbeCaptureOptions, type WebGpuProbeCaptureSubmission,
  type WebGpuProbeSamplingBinding,
} from "./webgpuProbeCaptureTypes.js";

interface TransactionState {
  readonly generation: number;
  readonly context: ProbeCaptureBeginContext;
  readonly capture: ProbeVolume;
  readonly output: ProbeVolume;
  readonly uniform: GPUBuffer;
  readonly metadata: GPUBuffer;
  readonly updateList: GPUBuffer;
  readonly allocationChecked: Promise<void>;
  readonly rawMoments?: ProbeVolume;
  readonly outputMoments?: ProbeVolume;
  readonly momentsUniform?: GPUBuffer;
  captures: number;
  filters: number;
  mips: number;
  submitted: boolean;
  completed: boolean;
  retirement?: Promise<void>;
  settled: boolean;
}
interface CommittedVolume { readonly volume: ProbeVolume; readonly metadata: GPUBuffer;
  readonly moments?: ProbeVolume; readonly plan: ProbeClipmapPlan }
/** Concrete double-buffered WebGPU capture/filter/mip adapter for the probe scheduler. */
export class WebGpuProbeCaptureAdapter implements ProbeCaptureAdapter<
  WebGpuProbeCaptureSubmission, WebGpuProbeSamplingBinding> {
  readonly deviceEpoch: string;
  private readonly captureLayout: GPUBindGroupLayout;
  private readonly filterLayout: GPUBindGroupLayout;
  private readonly mipLayout: GPUBindGroupLayout;
  private readonly pipelines: Readonly<Record<"clearCapture" | "clearFiltered" | "capture" | "filter" | "mip", GPUComputePipeline>>;
  private readonly sampler: GPUSampler;
  private readonly fallback: ProbeVector3;
  private readonly maxTransientBytes: number;
  private readonly dynamicHysteresis: number;
  private readonly energyClamp: number;
  private readonly staticHysteresis: number;
  private readonly pending = new Set<TransactionState>();
  private readonly submissionStates = new WeakMap<WebGpuProbeCaptureSubmission, TransactionState>();
  private readonly pool: WebGpuProbeCapturePool;
  private readonly momentsPipeline?: WebGpuProbeMomentsPipeline;
  private committed: CommittedVolume | undefined;
  private binding: WebGpuProbeSamplingBinding | undefined;
  private generation = 0;
  private disposed = false;

  constructor(private readonly session: DeviceSession, deviceEpoch: string,
    private readonly options: WebGpuProbeCaptureOptions = {}) {
    if (session.state !== "ready") throw new Error("GPU session is not ready for probe capture.");
    if (!/^[0-9A-Za-z][0-9A-Za-z._:-]{0,127}$/.test(deviceEpoch)) throw new TypeError("Invalid probe capture epoch.");
    this.deviceEpoch = deviceEpoch; this.fallback = validateProbeRadiance(options.fallbackRadiance ?? [0, 0, 0]);
    this.dynamicHysteresis = validateProbeHysteresis(options.dynamicIrradianceHysteresis ?? 0.85);
    this.energyClamp = validateProbeEnergyClamp(options.energyClamp ?? 0);
    this.staticHysteresis = validateProbeHysteresis(options.staticIrradianceHysteresis ?? 0);
    this.maxTransientBytes = positiveProbeInteger(options.maxTransientBytes ?? 32 * 1024 * 1024, "maxTransientBytes");
    if (options.captureVisibilityMoments !== undefined && typeof options.captureVisibilityMoments !== "boolean") {
      throw new TypeError("captureVisibilityMoments must be boolean.");
    }
    if (options.captureVisibilityMoments && !options.encodeSourceRadiance) {
      throw new Error("Visibility moments require a real scene radiance encoder.");
    }
    this.pool = new WebGpuProbeCapturePool(session, options.captureVisibilityMoments ? 6 : 3,
      options.captureVisibilityMoments ? 6 : 4);
    if (options.captureVisibilityMoments) this.momentsPipeline = new WebGpuProbeMomentsPipeline(session);
    const device = session.device, module = device.createShaderModule({
      label: "Deep GI probe capture/filter/mip WGSL", code: WEBGPU_PROBE_CAPTURE_WGSL });
    this.captureLayout = device.createBindGroupLayout({ label: "Deep GI probe capture layout", entries: [
      probeStorageLayout(0), probeUniformLayout(1), probeStorageTextureLayout(2),
    ] });
    this.filterLayout = device.createBindGroupLayout({ label: "Deep GI probe filter layout", entries: [
      probeStorageLayout(0), probeUniformLayout(1), probeSampledTextureLayout(3), probeStorageTextureLayout(4),
      probeSampledTextureLayout(7),
    ] });
    this.mipLayout = device.createBindGroupLayout({ label: "Deep GI probe mip layout", entries: [
      probeSampledTextureLayout(5), probeStorageTextureLayout(6),
    ] });
    const pipeline = (label: string, layout: GPUBindGroupLayout, entryPoint: string) => device.createComputePipeline({
      label, layout: device.createPipelineLayout({ label: `${label} pipeline layout`, bindGroupLayouts: [layout] }),
      compute: { module, entryPoint },
    });
    this.pipelines = Object.freeze({
      clearCapture: pipeline("Deep GI clear capture", this.captureLayout, "clearCapture"),
      clearFiltered: pipeline("Deep GI clear filtered", this.filterLayout, "clearFiltered"),
      capture: pipeline("Deep GI fallback capture", this.captureLayout, "captureFallback"),
      filter: pipeline("Deep GI irradiance filter", this.filterLayout, "filterIrradiance"),
      mip: pipeline("Deep GI mip builder", this.mipLayout, "buildMip"),
    });
    this.sampler = device.createSampler({ label: "Deep GI probe sampling", magFilter: "linear",
      minFilter: "linear", mipmapFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    void device.lost.then(() => this.dispose(), () => this.dispose()).catch(() => undefined);
  }

  get current(): WebGpuProbeSamplingBinding | undefined { return !this.disposed
    && this.session.state === "ready" ? this.binding : undefined; }

  begin(context: ProbeCaptureBeginContext): ProbeCaptureTransaction<
    WebGpuProbeCaptureSubmission, WebGpuProbeSamplingBinding> {
    this.assertReady(context.deviceEpoch);
    const dimensions = validateProbeVolume(this.session.device, context.plan, this.maxTransientBytes);
    const momentDimensions = this.momentsPipeline ? probeMomentsVolumeSize(dimensions) : undefined;
    if (momentDimensions && (dimensions.bytes * 2 + momentDimensions.bytes * 2 + 16
      + WEBGPU_PROBE_UNIFORM_BYTES + DEEP_GI_TEXTURE_LEVEL_METADATA_BYTES
      + context.plan.profile.updateListBytes > this.maxTransientBytes)) {
      throw new RangeError("Probe visibility moments exceed transient budget.");
    }
    const generation = ++this.generation;
    const staged = gpuValidatedStage(this.session.device, () => {
      let capture: ProbeVolume | undefined, output: ProbeVolume | undefined;
      let uniformBuffer: GPUBuffer | undefined, metadata: GPUBuffer | undefined, updateList: GPUBuffer | undefined;
      let rawMoments: ProbeVolume | undefined, outputMoments: ProbeVolume | undefined, momentsUniform: GPUBuffer | undefined;
      try {
        capture = this.pool.takeVolume(dimensions); output = this.pool.takeVolume(dimensions);
        if (momentDimensions) {
          rawMoments = this.pool.takeVolume(momentDimensions, "rgba32float");
          outputMoments = this.pool.takeVolume(momentDimensions, "rgba32float");
          momentsUniform = this.pool.takeBuffer("Deep GI moment grid shape", 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
          // shape.z = lane 数（F5 方案 A：lane0 moments + lane1..3 RGB L1 SH）。
          this.session.device.queue.writeBuffer(momentsUniform, 0,
            new Uint32Array([context.plan.profile.gridSize[2], context.plan.updates.length,
              PROBE_RADIANCE_MOMENT_LANES, 0]));
        }
        uniformBuffer = this.pool.takeBuffer("Deep GI probe capture uniform", WEBGPU_PROBE_UNIFORM_BYTES,
          GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
        metadata = this.pool.takeBuffer("Deep GI committed level metadata", DEEP_GI_TEXTURE_LEVEL_METADATA_BYTES,
          GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
        updateList = this.pool.takeBuffer("Deep GI private probe updates", context.plan.profile.updateListBytes,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
        const hasHistory = this.canCopyPrevious(context, dimensions.key);
        this.session.device.queue.writeBuffer(uniformBuffer, 0,
          packProbeCaptureUniform(context.plan, this.fallback, this.dynamicHysteresis, hasHistory,
            this.energyClamp, this.staticHysteresis));
        this.session.device.queue.writeBuffer(metadata, 0, packTextureLevels(context.plan));
        this.session.device.queue.writeBuffer(updateList, 0, packProbeUpdates(context.plan.updates,
          context.publication?.dynamicUpdateIndices));
        return { capture, output, uniform: uniformBuffer, metadata, updateList,
          ...(rawMoments && outputMoments && momentsUniform ? { rawMoments, outputMoments, momentsUniform } : {}) };
      } catch (error) {
        if (capture) this.pool.recycleVolume(capture);
        if (output) this.pool.recycleVolume(output);
        if (uniformBuffer) this.pool.recycleBuffer(uniformBuffer);
        if (metadata) this.pool.recycleBuffer(metadata);
        if (updateList) this.pool.recycleBuffer(updateList);
        if (rawMoments) this.pool.recycleVolume(rawMoments);
        if (outputMoments) this.pool.recycleVolume(outputMoments);
        if (momentsUniform) this.pool.recycleBuffer(momentsUniform);
        throw error;
      }
    }, "Probe capture allocation failed");
    void staged.checked.catch(() => {});
    const state: TransactionState = { generation, context, ...staged.value,
      allocationChecked: staged.checked, captures: 0, filters: 0, mips: 0,
      submitted: false, completed: false, settled: false };
    this.pending.add(state);
    return {
      encodeCapture: (update, index) => { assertProbeUpdate(context.plan, update, index); state.captures++; },
      encodeFilter: (update, index) => { assertProbeUpdate(context.plan, update, index); state.filters++; },
      encodeMips: (update, index) => { assertProbeUpdate(context.plan, update, index); state.mips++; },
      finish: () => this.finish(state),
      commit: () => this.commit(state),
      rollback: () => this.rollback(state),
    };
  }

  async submit(submission: WebGpuProbeCaptureSubmission, signal: AbortSignal): Promise<void> {
    this.assertReady(this.deviceEpoch); signal.throwIfAborted();
    const state = this.submissionStates.get(submission);
    if (!state || state.submitted) throw new Error("Probe capture submission is invalid or already submitted.");
    this.assertPending(state);
    state.submitted = true;
    try { this.session.device.queue.submit([submission.commandBuffer]); }
    catch (error) { void submission.checked.catch(() => {}); throw error; }
    const workDone = Promise.resolve().then(() => this.session.device.queue.onSubmittedWorkDone());
    state.retirement = Promise.allSettled([submission.checked, workDone]).then(() => {});
    await Promise.all([submission.checked, workDone]);
    signal.throwIfAborted(); this.assertReady(this.deviceEpoch); state.completed = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.generation++;
    const pending = [...this.pending], volumes: ProbeVolume[] = [], buffers: GPUBuffer[] = [];
    this.pending.clear();
    if (this.committed) {
      volumes.push(this.committed.volume);
      if (this.committed.moments) volumes.push(this.committed.moments);
      buffers.push(this.committed.metadata);
    }
    this.committed = undefined; this.binding = undefined;
    pending.forEach(state => { if (!state.settled) {
      state.settled = true;
      if (state.retirement) void state.retirement.then(() => this.releaseState(state)).catch(() => undefined);
      else {
        volumes.push(state.capture, state.output);
        if (state.rawMoments) volumes.push(state.rawMoments);
        if (state.outputMoments) volumes.push(state.outputMoments);
        buffers.push(state.uniform, state.metadata, state.updateList);
        if (state.momentsUniform) buffers.push(state.momentsUniform);
      }
    } });
    this.pool.dispose(volumes, buffers);
  }

  private finish(state: TransactionState): WebGpuProbeCaptureSubmission {
    this.assertPending(state); const count = state.context.plan.updates.length;
    if (state.captures !== count || state.filters !== count || state.mips !== count) {
      throw new Error("Probe capture transaction phases are incomplete.");
    }
    const staged = gpuValidatedStage(this.session.device, () => {
      const encoder = this.session.device.createCommandEncoder({ label: "Deep GI probe capture batch" });
      this.encodePasses(encoder, state); return encoder.finish();
    }, "Probe capture command encoding failed");
    const checked = Promise.all([state.allocationChecked, staged.checked]).then(() => {});
    void checked.catch(() => {});
    const submission = Object.freeze({ commandBuffer: staged.value, checked });
    this.submissionStates.set(submission, state); return submission;
  }

  private encodePasses(encoder: GPUCommandEncoder, state: TransactionState): void {
    const plan = state.context.plan, copyPrevious = this.canCopyPrevious(state.context, state.output.key);
    if (copyPrevious) encoder.copyTextureToTexture({ texture: this.committed!.volume.texture },
      { texture: state.output.texture }, { width: state.output.width, height: state.output.height,
        depthOrArrayLayers: state.output.layers });
    const captureBinding = this.captureBinding(state), filterBinding = this.filterBinding(state);
    this.volumePass(encoder, "Deep GI clear capture", this.pipelines.clearCapture, captureBinding,
      state.capture.width, state.capture.height, state.capture.layers);
    if (!copyPrevious) this.volumePass(encoder, "Deep GI clear irradiance", this.pipelines.clearFiltered,
      filterBinding, state.output.width, state.output.height, state.output.layers);
    if (state.rawMoments && state.outputMoments) {
      this.momentsPipeline!.clear(encoder, state.rawMoments);
      if (copyPrevious && this.committed?.moments) {
        encoder.copyTextureToTexture({ texture: this.committed.moments.texture },
          { texture: state.outputMoments.texture }, [state.outputMoments.width, state.outputMoments.height, state.outputMoments.layers]);
      } else this.momentsPipeline!.clear(encoder, state.outputMoments);
    }
    if (this.options.encodeSourceRadiance) plan.updates.forEach((update, updateIndex) =>
      this.options.encodeSourceRadiance!({ encoder, update, updateIndex, destination: state.capture.texture,
        destinationView: state.capture.levels[0]!,
        ...(state.rawMoments ? { momentsDestinationView: state.rawMoments.view } : {}),
        destinationOrigin: Object.freeze({
          x: update.localCell[0], y: update.localCell[1],
          z: update.localCell[2] + update.level * plan.profile.gridSize[2] }), context: state.context }));
    else this.linearPass(encoder, "Deep GI fallback capture", this.pipelines.capture, captureBinding,
      Math.ceil(plan.updates.length / WEBGPU_PROBE_CAPTURE_WORKGROUP));
    this.linearPass(encoder, "Deep GI filter irradiance", this.pipelines.filter, filterBinding,
      Math.ceil(plan.updates.length / WEBGPU_PROBE_CAPTURE_WORKGROUP));
    if (state.rawMoments && state.outputMoments && state.momentsUniform) {
      this.momentsPipeline!.publish(encoder, state.context, state.updateList, state.momentsUniform,
        state.rawMoments, state.outputMoments, state.output);
    }
    for (let mip = 1; mip < state.output.mipCount; mip++) {
      const bindGroup = this.session.device.createBindGroup({ label: `Deep GI mip bindings ${mip}`,
        layout: this.mipLayout, entries: [{ binding: 5, resource: state.output.levels[mip - 1]! },
          { binding: 6, resource: state.output.levels[mip]! }] });
      this.volumePass(encoder, `Deep GI build mip ${mip}`, this.pipelines.mip, bindGroup,
        probeMipSize(state.output.width, mip), probeMipSize(state.output.height, mip), state.output.layers);
    }
  }

  private captureBinding(state: TransactionState): GPUBindGroup {
    return this.session.device.createBindGroup({ label: "Deep GI capture bindings", layout: this.captureLayout,
      entries: [{ binding: 0, resource: { buffer: state.updateList } },
        { binding: 1, resource: { buffer: state.uniform, size: WEBGPU_PROBE_UNIFORM_BYTES } },
        { binding: 2, resource: state.capture.levels[0]! }] });
  }
  private filterBinding(state: TransactionState): GPUBindGroup {
    const history = this.canCopyPrevious(state.context, state.output.key) ? this.committed!.volume : state.capture;
    return this.session.device.createBindGroup({ label: "Deep GI filter bindings", layout: this.filterLayout,
      entries: [{ binding: 0, resource: { buffer: state.updateList } },
        { binding: 1, resource: { buffer: state.uniform, size: WEBGPU_PROBE_UNIFORM_BYTES } },
        { binding: 3, resource: state.capture.levels[0]! }, { binding: 4, resource: state.output.levels[0]! },
        { binding: 7, resource: history.levels[0]! }] });
  }
  private volumePass(encoder: GPUCommandEncoder, label: string, pipeline: GPUComputePipeline,
    binding: GPUBindGroup, width: number, height: number, layers: number): void {
    const pass = encoder.beginComputePass({ label }); pass.setPipeline(pipeline); pass.setBindGroup(0, binding);
    pass.dispatchWorkgroups(Math.ceil(width / WEBGPU_PROBE_VOLUME_WORKGROUP),
      Math.ceil(height / WEBGPU_PROBE_VOLUME_WORKGROUP), layers); pass.end();
  }
  private linearPass(encoder: GPUCommandEncoder, label: string, pipeline: GPUComputePipeline,
    binding: GPUBindGroup, workgroups: number): void {
    if (!workgroups) return;
    const pass = encoder.beginComputePass({ label }); pass.setPipeline(pipeline); pass.setBindGroup(0, binding);
    pass.dispatchWorkgroups(workgroups); pass.end(); }

  private commit(state: TransactionState): WebGpuProbeSamplingBinding {
    this.assertPending(state);
    if (!state.completed) throw new Error("Probe capture submission has not completed.");
    if (state.generation !== this.generation) { this.rollback(state); throw probeAbortError("Stale probe capture transaction."); }
    state.settled = true; this.pending.delete(state);
    const previous = this.committed; this.committed = { volume: state.output, metadata: state.metadata,
      plan: state.context.plan, ...(state.outputMoments ? { moments: state.outputMoments } : {}) };
    this.binding = Object.freeze({ deviceEpoch: this.deviceEpoch, generation: state.generation,
      profileKey: state.context.resource.profileKey, texture: state.output.texture, view: state.output.view,
      sampler: this.sampler, levelMetadataBuffer: state.metadata,
      ...(state.outputMoments ? { momentsView: state.outputMoments.view } : {}),
      format: WEBGPU_PROBE_VOLUME_FORMAT, width: state.output.width, height: state.output.height,
      depthOrArrayLayers: state.output.layers, mipLevelCount: state.output.mipCount,
      allocatedBytes: state.output.bytes + (state.outputMoments?.bytes ?? 0) });
    this.pool.recycleVolume(state.capture); this.pool.recycleBuffer(state.uniform);
    this.pool.recycleBuffer(state.updateList);
    if (state.rawMoments) this.pool.recycleVolume(state.rawMoments);
    if (state.momentsUniform) this.pool.recycleBuffer(state.momentsUniform);
    if (previous) {
      this.pool.recycleVolume(previous.volume); this.pool.recycleBuffer(previous.metadata);
      if (previous.moments) this.pool.recycleVolume(previous.moments);
    }
    return this.binding;
  }

  private rollback(state: TransactionState): void {
    if (state.settled) return;
    state.settled = true; this.pending.delete(state); this.releaseOrRecycle(state);
  }
  private releaseState(state: TransactionState): void {
    state.settled = true;
    runResourceCleanup("Probe capture transaction release failed.", [
      () => this.session.release(state.capture.texture), () => this.session.release(state.output.texture),
      () => this.session.release(state.uniform), () => this.session.release(state.metadata),
      () => this.session.release(state.updateList),
      ...(state.rawMoments ? [() => this.session.release(state.rawMoments!.texture)] : []),
      ...(state.outputMoments ? [() => this.session.release(state.outputMoments!.texture)] : []),
      ...(state.momentsUniform ? [() => this.session.release(state.momentsUniform!)] : []) ]);
  }
  private releaseOrRecycle(state: TransactionState): void {
    const retire = () => { if (this.disposed || this.session.state !== "ready") this.releaseState(state);
    else {
      this.pool.recycleVolume(state.capture); this.pool.recycleVolume(state.output);
      this.pool.recycleBuffer(state.uniform); this.pool.recycleBuffer(state.metadata);
      this.pool.recycleBuffer(state.updateList);
      if (state.rawMoments) this.pool.recycleVolume(state.rawMoments);
      if (state.outputMoments) this.pool.recycleVolume(state.outputMoments);
      if (state.momentsUniform) this.pool.recycleBuffer(state.momentsUniform);
    } };
    if (state.retirement) void state.retirement.then(retire).catch(() => undefined); else retire();
  }
  private canCopyPrevious(context: ProbeCaptureBeginContext, key: string): boolean {
    return this.committed?.volume.key === key && context.publication?.invalidation === "none"
      && (!this.momentsPipeline || sameProbeLevels(this.committed.plan.levels, context.plan.levels));
  }
  private assertPending(state: TransactionState): void {
    this.assertReady(state.context.deviceEpoch);
    if (state.settled || !this.pending.has(state)) throw new Error("Probe capture transaction is settled.");
  }
  private assertReady(epoch: string): void {
    if (this.disposed) throw new Error("Probe capture adapter is disposed.");
    if (epoch !== this.deviceEpoch) throw new Error("Probe capture adapter epoch mismatch.");
    if (this.session.state !== "ready") throw new Error("GPU session is not ready for probe capture.");
  }
}

function packTextureLevels(plan: ProbeClipmapPlan): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(DEEP_GI_TEXTURE_LEVEL_METADATA_BYTES);
  result.set(new Uint8Array(packProbeLevels(plan.levels))); return result; }
