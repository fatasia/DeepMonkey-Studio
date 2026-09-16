/// <reference types="@webgpu/types" />
import type { DeviceSession } from "./deviceSession.js";
import type { DeformationStaticUpload } from "./deformationStaticSources.js";
import { failWithResourceCleanup, runResourceCleanup } from "./resourceCleanup.js";
import { packJointPalette, prepareSkinningInput } from "./gpuSkinningPacking.js";
import type { GpuSkinningResult, SkinningPalette, SkinningSource } from "./gpuSkinningTypes.js";
import { GPU_SKINNING_INPUT_STRIDE, GPU_SKINNING_JOINT_STRIDE, GPU_SKINNING_OUTPUT_STRIDE,
  GPU_SKINNING_WGSL, GPU_SKINNING_WORKGROUP_SIZE } from "./gpuSkinningWgsl.js";

interface SkinningResources {
  readonly input: GPUBuffer;
  readonly output: GPUBuffer;
  readonly palettes: readonly [GPUBuffer, GPUBuffer];
  readonly uniform: GPUBuffer;
  bindGroup: GPUBindGroup;
  activePalette: 0 | 1;
  readonly vertexCount: number;
  readonly jointCount: number;
  readonly hasTangents: boolean;
  readonly outputStride: 32 | 48;
  readonly source: SkinningSource;
  palette: SkinningPalette;
}

/** Compute skinning with an atomic double-buffered joint palette and vertex-buffer compatible output. */
export class GpuSkinner {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private resources: SkinningResources | undefined;
  private disposed = false;

  constructor(private readonly session: DeviceSession, private readonly staticUpload?: DeformationStaticUpload) {
    if (staticUpload && staticUpload.session !== session) throw new Error("Skinning static lease belongs to another device epoch.");
    if (session.state !== "ready") throw new Error("GPU session is not ready for skinning.");
    const device = session.device, module = device.createShaderModule({ label: "Deep GPU skinning WGSL", code: GPU_SKINNING_WGSL });
    this.layout = device.createBindGroupLayout({ label: "Deep GPU skinning layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
    ] });
    this.pipeline = device.createComputePipeline({ label: "Deep GPU skinning pipeline",
      layout: device.createPipelineLayout({ label: "Deep GPU skinning pipeline layout", bindGroupLayouts: [this.layout] }),
      compute: { module, entryPoint: "skinVertices" } });
  }

  get vertexCount(): number { return this.resources?.vertexCount ?? 0; }

  setSource(source: SkinningSource, palette: SkinningPalette): boolean {
    this.assertReady();
    const current = this.resources;
    if (current && this.staticUpload && source.revision !== current.source.revision) throw new Error("Shared skinning source lease cannot change revision.");
    if (current && source.revision < current.source.revision) throw new Error("Stale skinning source revision.");
    if (current && source.revision === current.source.revision) {
      if (source !== current.source) throw new Error("Skinning source changed without a revision.");
      return this.updatePalette(palette);
    }
    const prepared = prepareSkinningInput(source, palette), created: GPUBuffer[] = [], device = this.session.device;
    const hasTangents = prepared.tangents !== undefined, outputStride = hasTangents ? 48 : GPU_SKINNING_OUTPUT_STRIDE;
    const inputBytes = prepared.vertices.byteLength + (prepared.tangents?.byteLength ?? 0);
    const sizes = [inputBytes, prepared.vertexCount * outputStride, prepared.joints.byteLength];
    if (device.limits && (sizes.some(bytes => bytes > device.limits.maxBufferSize || bytes > device.limits.maxStorageBufferBindingSize)
      || Math.ceil(prepared.vertexCount / GPU_SKINNING_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension))
      throw new Error("Skinning buffers exceed device capacity.");
    const allocate = (label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer => {
      const buffer = this.session.own(device.createBuffer({ label, size, usage })); created.push(buffer); return buffer;
    };
    let candidate: SkinningResources;
    try {
      const staticBytes = new Uint8Array(this.staticUpload ? inputBytes : 0);
      if (this.staticUpload) { staticBytes.set(new Uint8Array(prepared.vertices));
        if (prepared.tangents) staticBytes.set(new Uint8Array(prepared.tangents.buffer, prepared.tangents.byteOffset, prepared.tangents.byteLength), prepared.vertices.byteLength); }
      const input = this.staticUpload?.upload("Deep skinning source", staticBytes)
        ?? allocate("Deep skinning source", inputBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      const output = allocate("Deep skinned vertices", prepared.vertexCount * outputStride,
        GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC);
      const palettes = [0, 1].map(index => allocate(`Deep skinning palette ${index}`, prepared.jointCount * GPU_SKINNING_JOINT_STRIDE,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)) as [GPUBuffer, GPUBuffer];
      const uniform = allocate("Deep skinning parameters", 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      if (!this.staticUpload) { device.queue.writeBuffer(input, 0, prepared.vertices);
        if (prepared.tangents) device.queue.writeBuffer(input, prepared.vertices.byteLength, prepared.tangents); }
      device.queue.writeBuffer(palettes[0], 0, prepared.joints);
      device.queue.writeBuffer(uniform, 0, new Uint32Array([prepared.vertexCount, prepared.jointCount, hasTangents ? 1 : 0, 0]));
      const bindGroup = this.binding(input, palettes[0], output, uniform);
      candidate = { input, output, palettes, uniform, bindGroup, activePalette: 0,
        vertexCount: prepared.vertexCount, jointCount: prepared.jointCount, source, palette, hasTangents, outputStride };
    } catch (error) {
      failWithResourceCleanup(error, "Skinning preparation failed.", created.map(buffer => () => this.session.release(buffer)));
    }
    this.resources = candidate;
    if (current) this.release(current);
    return true;
  }

  updatePalette(palette: SkinningPalette): boolean {
    this.assertReady();
    const resources = this.resources;
    if (!resources) throw new Error("Skinning source is not prepared.");
    if (palette.revision < resources.palette.revision) throw new Error("Stale skinning palette revision.");
    if (palette.revision === resources.palette.revision) {
      if (palette !== resources.palette) throw new Error("Skinning palette changed without a revision.");
      return false;
    }
    const packed = packJointPalette(palette);
    if (packed.byteLength !== resources.jointCount * GPU_SKINNING_JOINT_STRIDE) throw new Error("Skinning joint count cannot change without a source update.");
    const next = resources.activePalette === 0 ? 1 : 0;
    this.session.device.queue.writeBuffer(resources.palettes[next], 0, packed);
    const binding = this.binding(resources.input, resources.palettes[next], resources.output, resources.uniform);
    resources.bindGroup = binding; resources.activePalette = next; resources.palette = palette;
    return true;
  }

  encode(encoder: GPUCommandEncoder): GpuSkinningResult {
    this.assertReady(); const resources = this.resources;
    if (!resources) throw new Error("Skinning source is not prepared.");
    const pass = encoder.beginComputePass({ label: "Deep GPU skinning" });
    let failure: { error: unknown } | undefined;
    try {
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, resources.bindGroup);
      pass.dispatchWorkgroups(Math.ceil(resources.vertexCount / GPU_SKINNING_WORKGROUP_SIZE));
    } catch (error) { failure = { error }; }
    finally {
      if (failure) failWithResourceCleanup(failure.error, "Skinning encode failed.", [() => pass.end()]);
      pass.end();
    }
    return Object.freeze({ output: resources.output, vertexCount: resources.vertexCount, outputStride: resources.outputStride, hasTangents: resources.hasTangents,
      sourceRevision: resources.source.revision, paletteRevision: resources.palette.revision });
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    const resources = this.resources; this.resources = undefined;
    if (resources) this.release(resources);
  }

  private binding(input: GPUBuffer, palette: GPUBuffer, output: GPUBuffer, uniform: GPUBuffer): GPUBindGroup {
    return this.session.device.createBindGroup({ label: "Deep GPU skinning bindings", layout: this.layout, entries: [
      { binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: palette } },
      { binding: 2, resource: { buffer: output } }, { binding: 3, resource: { buffer: uniform } },
    ] });
  }
  private assertReady(): void {
    if (this.disposed) throw new Error("GPU skinner is disposed.");
    if (this.session.state !== "ready") {
      const resources = this.resources; this.resources = undefined;
      failWithResourceCleanup(new Error("GPU session is not ready for skinning."), "Skinning device cleanup failed.",
        resources ? [() => this.release(resources)] : []);
    }
  }
  private release(resources: SkinningResources): void {
    runResourceCleanup("Skinning resource cleanup failed.",
      [...(this.staticUpload ? [] : [resources.input]), resources.output, ...resources.palettes, resources.uniform].map(buffer => () => this.session.release(buffer)));
  }
}

export { cpuSkinVertices, packJointPalette, prepareSkinningInput } from "./gpuSkinningPacking.js";
export { GPU_SKINNING_INPUT_STRIDE, GPU_SKINNING_JOINT_STRIDE, GPU_SKINNING_OUTPUT_STRIDE,
  GPU_SKINNING_WGSL, GPU_SKINNING_WORKGROUP_SIZE } from "./gpuSkinningWgsl.js";
export type { GpuSkinningResult, PreparedSkinningInput, SkinningPalette, SkinningSource } from "./gpuSkinningTypes.js";
