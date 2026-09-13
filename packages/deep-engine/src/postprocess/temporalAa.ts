/// <reference types="@webgpu/types" />
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { temporalAaJitter, validateTemporalAaJitter, validateTemporalAaOptions } from "./temporalAaCpu.js";
import { TEMPORAL_AA_COLOR_FORMAT, TEMPORAL_AA_DEPTH_FORMAT, TEMPORAL_AA_MOTION_FORMAT,
  type TemporalAaOptions, type TemporalAaResult, type TemporalAaSource } from "./temporalAaTypes.js";
import { TEMPORAL_AA_WGSL, TEMPORAL_AA_WORKGROUP_SIZE } from "./temporalAaWgsl.js";

const PARAMETER_BYTES = 48;
interface Allocation { width: number; height: number; colors: readonly [GPUTexture, GPUTexture]; depths: readonly [GPUTexture, GPUTexture]; parameters: readonly [GPUBuffer, GPUBuffer] }

/** Full-resolution HDR TAA history with two-frame color/depth ping-pong. */
export class TemporalAaPass {
  private readonly layout: GPUBindGroupLayout; private readonly pipeline: GPUComputePipeline;
  private allocation: Allocation | undefined; private historyIndex = 0; private lastRevision: number | undefined; private lastJitter: readonly [number, number] = [0, 0]; private disposed = false;
  constructor(private readonly session: DeviceSession) {
    this.assertReady(); const device = session.device, module = device.createShaderModule({ label: "Deep temporal AA WGSL", code: TEMPORAL_AA_WGSL });
    this.layout = device.createBindGroupLayout({ label: "Deep temporal AA layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: PARAMETER_BYTES } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: TEMPORAL_AA_COLOR_FORMAT } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: TEMPORAL_AA_DEPTH_FORMAT } },
    ] });
    this.pipeline = device.createComputePipeline({ label: "Deep temporal AA resolve pipeline", layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }), compute: { module, entryPoint: "resolveTemporal" } });
  }
  encode(encoder: GPUCommandEncoder, source: TemporalAaSource, options: TemporalAaOptions): TemporalAaResult {
    this.assertUsable(); validateSource(this.session.device, source); validateTemporalAaOptions(options);
    const previousAllocation = this.allocation, resized = !previousAllocation || previousAllocation.width !== source.color.width || previousAllocation.height !== source.color.height;
    let candidate: Allocation | undefined;
    try {
      candidate = resized ? this.allocate(source.color.width, source.color.height) : previousAllocation;
      const invalidation = !previousAllocation ? "first-frame" : resized ? "resize" : source.cameraCut ? "camera-cut"
        : this.lastRevision === undefined || source.revision !== this.lastRevision + 1 ? "revision-gap" : null;
      const historyUsed = invalidation === null, writeIndex: 0 | 1 = historyUsed ? (1 - this.historyIndex) as 0 | 1 : 0;
      const readIndex: 0 | 1 = historyUsed ? this.historyIndex as 0 | 1 : 1;
      const jitter = source.currentJitter ? jitterSnapshot(source.currentJitter) : temporalAaJitter(source.revision);
      const previousJitter = source.previousJitter ? jitterSnapshot(source.previousJitter) : historyUsed ? this.lastJitter : jitter;
      const views = [source.color.createView(), source.depth.createView(), source.motion.createView(), candidate!.colors[readIndex].createView(), candidate!.depths[readIndex].createView()] as const;
      const entries: GPUBindGroupEntry[] = views.map((resource, binding) => ({ binding, resource }));
      entries.push({ binding: 5, resource: { buffer: candidate!.parameters[writeIndex] } }, { binding: 6, resource: candidate!.colors[writeIndex].createView() }, { binding: 7, resource: candidate!.depths[writeIndex].createView() });
      const bindGroup = this.session.device.createBindGroup({ layout: this.layout, entries });
      this.session.device.queue.writeBuffer(candidate!.parameters[writeIndex], 0, packParameters(candidate!, historyUsed, jitter, previousJitter, options));
      const pass = encoder.beginComputePass({ label: "Deep temporal AA resolve" }); pass.setPipeline(this.pipeline); pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(candidate!.width / TEMPORAL_AA_WORKGROUP_SIZE), Math.ceil(candidate!.height / TEMPORAL_AA_WORKGROUP_SIZE)); pass.end();
      if (resized) { this.allocation = candidate; if (previousAllocation) this.release(previousAllocation); }
      this.historyIndex = writeIndex; this.lastRevision = source.revision; this.lastJitter = jitter;
      return Object.freeze({ texture: candidate!.colors[writeIndex], format: TEMPORAL_AA_COLOR_FORMAT, width: candidate!.width, height: candidate!.height,
        revision: source.revision, jitter, previousJitter, historyUsed, historyInvalidation: invalidation });
    } catch (error) { if (candidate && candidate !== previousAllocation) this.release(candidate); throw error; }
  }
  reset(): void { this.lastRevision = undefined; }
  dispose(): void { if (this.disposed) return; this.disposed = true; if (this.allocation) this.release(this.allocation); this.allocation = undefined; this.lastRevision = undefined; }
  private allocate(width: number, height: number): Allocation {
    const owned: Array<GPUTexture | GPUBuffer> = [], device = this.session.device;
    const texture = (format: GPUTextureFormat, label: string) => { const value = this.session.own(device.createTexture({ label, size: [width, height], format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC })); owned.push(value); return value; };
    const buffer = (label: string) => { const value = this.session.own(device.createBuffer({ label, size: PARAMETER_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })); owned.push(value); return value; };
    try { return { width, height, colors: [texture(TEMPORAL_AA_COLOR_FORMAT, "Deep TAA history color A"), texture(TEMPORAL_AA_COLOR_FORMAT, "Deep TAA history color B")],
      depths: [texture(TEMPORAL_AA_DEPTH_FORMAT, "Deep TAA history depth A"), texture(TEMPORAL_AA_DEPTH_FORMAT, "Deep TAA history depth B")], parameters: [buffer("Deep TAA parameters A"), buffer("Deep TAA parameters B")] }; }
    catch (error) { for (const resource of owned) this.session.release(resource); throw error; }
  }
  private release(value: Allocation): void { for (const resource of [...value.colors, ...value.depths, ...value.parameters]) this.session.release(resource); }
  private assertReady(): void { if (this.session.state !== "ready") throw new Error("GPU session is not ready for temporal AA."); }
  private assertUsable(): void { if (this.disposed) throw new Error("Temporal AA pass is disposed."); if (this.session.state !== "ready") { if (this.allocation) this.release(this.allocation); this.allocation = undefined; throw new Error("GPU session is not ready for temporal AA."); } }
}
function validateSource(device: GPUDevice, source: TemporalAaSource): void {
  if (source.colorEncoding !== "linear-hdr" || source.depthEncoding !== "linear-view-depth-positive" || source.motionEncoding !== "current-to-previous-uv") throw new Error("TAA requires explicit linear HDR, positive linear view depth, and current-to-previous UV motion.");
  if (!Number.isSafeInteger(source.revision) || source.revision < 0 || (source.cameraCut !== undefined && typeof source.cameraCut !== "boolean")) throw new Error("Invalid TAA revision or cameraCut.");
  const hasCurrentJitter = source.currentJitter !== undefined, hasPreviousJitter = source.previousJitter !== undefined;
  if (hasCurrentJitter !== hasPreviousJitter) throw new Error("TAA currentJitter and previousJitter must be supplied together.");
  if (hasCurrentJitter) {
    validateTemporalAaJitter(source.currentJitter!, "TAA currentJitter"); validateTemporalAaJitter(source.previousJitter!, "TAA previousJitter");
  }
  const specs = [[source.color, TEMPORAL_AA_COLOR_FORMAT, "color"], [source.depth, TEMPORAL_AA_DEPTH_FORMAT, "depth"], [source.motion, TEMPORAL_AA_MOTION_FORMAT, "motion"]] as const;
  for (const [texture, format, name] of specs) {
    if (texture.format !== format || texture.dimension !== "2d" || texture.depthOrArrayLayers !== 1 || texture.sampleCount !== 1 || (texture.usage & GPUTextureUsage.TEXTURE_BINDING) === 0) throw new Error(`Invalid TAA ${name} texture; expected ${format} single-sample 2D TEXTURE_BINDING.`);
    if (texture.width !== source.color.width || texture.height !== source.color.height) throw new Error("TAA input dimensions must match.");
  }
  if (source.color.width < 1 || source.color.height < 1 || source.color.width > device.limits.maxTextureDimension2D || source.color.height > device.limits.maxTextureDimension2D
    || Math.ceil(source.color.width / TEMPORAL_AA_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension || Math.ceil(source.color.height / TEMPORAL_AA_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension) throw new Error("TAA dimensions exceed device limits.");
}
function packParameters(allocation: Allocation, valid: boolean, current: readonly [number, number], previous: readonly [number, number], options: TemporalAaOptions): ArrayBuffer {
  const buffer = new ArrayBuffer(PARAMETER_BYTES), uints = new Uint32Array(buffer), floats = new Float32Array(buffer); uints.set([allocation.width, allocation.height, valid ? 1 : 0, 0]);
  floats.set([...current, ...previous], 4); floats.set([options.feedback, options.depthThreshold, options.relativeDepthThreshold, 0], 8); return buffer;
}
function jitterSnapshot(value: readonly [number, number]): readonly [number, number] { return Object.freeze([value[0], value[1]]); }
