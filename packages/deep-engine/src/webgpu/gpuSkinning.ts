/// <reference types="@webgpu/types" />
import type { DeviceSession } from "./deviceSession.js";
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
  readonly source: SkinningSource;
  palette: SkinningPalette;
}

/** Compute skinning with an atomic double-buffered joint palette and vertex-buffer compatible output. */
export class GpuSkinner {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private resources: SkinningResources | undefined;
  private disposed = false;

  constructor(private readonly session: DeviceSession) {
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
    if (current && source.revision < current.source.revision) throw new Error("Stale skinning source revision.");
    if (current && source.revision === current.source.revision) {
      if (source !== current.source) throw new Error("Skinning source changed without a revision.");
      return this.updatePalette(palette);
    }
    const prepared = prepareSkinningInput(source, palette), created: GPUBuffer[] = [], device = this.session.device;
    const allocate = (label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer => {
      const buffer = this.session.own(device.createBuffer({ label, size, usage })); created.push(buffer); return buffer;
    };
    try {
      const input = allocate("Deep skinning source", prepared.vertexCount * GPU_SKINNING_INPUT_STRIDE,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      const output = allocate("Deep skinned vertices", prepared.vertexCount * GPU_SKINNING_OUTPUT_STRIDE,
        GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC);
      const palettes = [0, 1].map(index => allocate(`Deep skinning palette ${index}`, prepared.jointCount * GPU_SKINNING_JOINT_STRIDE,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)) as [GPUBuffer, GPUBuffer];
      const uniform = allocate("Deep skinning parameters", 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      device.queue.writeBuffer(input, 0, prepared.vertices); device.queue.writeBuffer(palettes[0], 0, prepared.joints);
      device.queue.writeBuffer(uniform, 0, new Uint32Array([prepared.vertexCount, prepared.jointCount, 0, 0]));
      const bindGroup = this.binding(input, palettes[0], output, uniform);
      const candidate: SkinningResources = { input, output, palettes, uniform, bindGroup, activePalette: 0,
        vertexCount: prepared.vertexCount, jointCount: prepared.jointCount, source, palette };
      this.resources = candidate;
      if (current) this.release(current);
      return true;
    } catch (error) {
      for (const buffer of created) this.session.release(buffer);
      throw error;
    }
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
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, resources.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(resources.vertexCount / GPU_SKINNING_WORKGROUP_SIZE)); pass.end();
    return Object.freeze({ output: resources.output, vertexCount: resources.vertexCount, outputStride: GPU_SKINNING_OUTPUT_STRIDE,
      sourceRevision: resources.source.revision, paletteRevision: resources.palette.revision });
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    if (this.resources) this.release(this.resources); this.resources = undefined;
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
      if (this.resources) this.release(this.resources); this.resources = undefined;
      throw new Error("GPU session is not ready for skinning.");
    }
  }
  private release(resources: SkinningResources): void {
    for (const buffer of [resources.input, resources.output, ...resources.palettes, resources.uniform]) this.session.release(buffer);
  }
}

export { cpuSkinVertices, packJointPalette, prepareSkinningInput } from "./gpuSkinningPacking.js";
export { GPU_SKINNING_INPUT_STRIDE, GPU_SKINNING_JOINT_STRIDE, GPU_SKINNING_OUTPUT_STRIDE,
  GPU_SKINNING_WGSL, GPU_SKINNING_WORKGROUP_SIZE } from "./gpuSkinningWgsl.js";
export type { GpuSkinningResult, PreparedSkinningInput, SkinningPalette, SkinningSource } from "./gpuSkinningTypes.js";
