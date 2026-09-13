/// <reference types="@webgpu/types" />
import type { DeviceSession } from "./deviceSession.js";
import { assertMorphWeightRange, packMorphWeights } from "./gpuMorphPacking.js";
import { prepareMorphSkinningInput } from "./gpuMorphSkinningPacking.js";
import type { GpuMorphSkinningResult, MorphSkinningDynamics, MorphSkinningSources,
  PreparedMorphSkinningInput } from "./gpuMorphSkinningTypes.js";
import { GPU_MORPH_SKINNING_OUTPUT_STRIDE, GPU_MORPH_SKINNING_WGSL,
  GPU_MORPH_SKINNING_WORKGROUP_SIZE } from "./gpuMorphSkinningWgsl.js";
import { packJointPalette } from "./gpuSkinningPacking.js";

interface FusedResources {
  readonly vertices: GPUBuffer; readonly deltas: GPUBuffer; readonly influences: GPUBuffer;
  readonly output: GPUBuffer; readonly morphWeights: readonly [GPUBuffer, GPUBuffer];
  readonly palettes: readonly [GPUBuffer, GPUBuffer]; readonly uniform: GPUBuffer;
  bindGroup: GPUBindGroup; activeMorphWeights: 0 | 1; activePalette: 0 | 1;
  readonly vertexCount: number; readonly targetCount: number; readonly jointCount: number; readonly flags: number;
  readonly maximumBaseMagnitude: number; readonly maximumDeltaMagnitude: number;
  readonly sources: MorphSkinningSources; dynamics: MorphSkinningDynamics;
}

/** Executes glTF's morph-then-skin order in one compute dispatch and one final vertex buffer. */
export class GpuMorphSkinner {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private resources: FusedResources | undefined;
  private disposed = false;

  constructor(private readonly session: DeviceSession) {
    if (session.state !== "ready") throw new Error("GPU session is not ready for fused morph skinning.");
    const device = session.device, module = device.createShaderModule({ label: "Deep fused morph skinning WGSL", code: GPU_MORPH_SKINNING_WGSL });
    this.layout = device.createBindGroupLayout({ label: "Deep fused morph skinning layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
    ] });
    this.pipeline = device.createComputePipeline({ label: "Deep fused morph skinning pipeline",
      layout: device.createPipelineLayout({ label: "Deep fused morph skinning pipeline layout", bindGroupLayouts: [this.layout] }),
      compute: { module, entryPoint: "deformMorphSkinVertices" } });
  }

  get vertexCount(): number { return this.resources?.vertexCount ?? 0; }

  setSource(sources: MorphSkinningSources, dynamics: MorphSkinningDynamics): boolean {
    this.assertReady(); const current = this.resources;
    if (current) {
      compareStatic(sources.morph, current.sources.morph, "morph");
      compareStatic(sources.skinning, current.sources.skinning, "skinning");
      if (sources.morph.revision === current.sources.morph.revision
        && sources.skinning.revision === current.sources.skinning.revision) return this.updateDynamics(dynamics);
    }
    const prepared = prepareMorphSkinningInput(sources.morph, sources.skinning, dynamics.morphWeights, dynamics.palette);
    validateCapacity(this.session.device, prepared); const created: GPUBuffer[] = [], device = this.session.device;
    const allocate = (label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer => {
      const buffer = this.session.own(device.createBuffer({ label, size, usage })); created.push(buffer); return buffer;
    };
    try {
      const vertices = allocate("Deep fused morph vertices", prepared.vertices.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      const deltas = allocate("Deep fused morph targets", prepared.deltas.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      const influences = allocate("Deep fused skin influences", prepared.influences.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      const output = allocate("Deep fused deformed vertices", prepared.vertexCount * GPU_MORPH_SKINNING_OUTPUT_STRIDE,
        GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC);
      const morphWeights = pair((index) => allocate(`Deep fused morph weights ${index}`, prepared.morphWeights.byteLength,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST));
      const palettes = pair((index) => allocate(`Deep fused joint palette ${index}`, prepared.joints.byteLength,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST));
      const uniform = allocate("Deep fused deformation parameters", 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      device.queue.writeBuffer(vertices, 0, prepared.vertices); device.queue.writeBuffer(deltas, 0, prepared.deltas);
      device.queue.writeBuffer(influences, 0, prepared.influences); device.queue.writeBuffer(morphWeights[0], 0, prepared.morphWeights);
      device.queue.writeBuffer(palettes[0], 0, prepared.joints);
      device.queue.writeBuffer(uniform, 0, new Uint32Array([prepared.vertexCount, prepared.targetCount, prepared.flags, prepared.jointCount]));
      const bindGroup = this.binding(vertices, deltas, morphWeights[0], influences, palettes[0], output, uniform);
      this.resources = { vertices, deltas, influences, output, morphWeights, palettes, uniform, bindGroup,
        activeMorphWeights: 0, activePalette: 0, vertexCount: prepared.vertexCount, targetCount: prepared.targetCount,
        jointCount: prepared.jointCount, flags: prepared.flags, maximumBaseMagnitude: prepared.maximumBaseMagnitude,
        maximumDeltaMagnitude: prepared.maximumDeltaMagnitude, sources, dynamics };
      if (current) this.release(current); return true;
    } catch (error) {
      for (const buffer of created) this.session.release(buffer); throw error;
    }
  }

  updateDynamics(dynamics: MorphSkinningDynamics): boolean {
    this.assertReady(); const resources = this.resources;
    if (!resources) throw new Error("Fused morph skinning source is not prepared.");
    const morphChanged = compareDynamic(dynamics.morphWeights, resources.dynamics.morphWeights, "morph weights");
    const paletteChanged = compareDynamic(dynamics.palette, resources.dynamics.palette, "skinning palette");
    if (!morphChanged && !paletteChanged) return false;
    const packedWeights = morphChanged ? packMorphWeights(dynamics.morphWeights, resources.targetCount) : undefined;
    if (packedWeights) assertMorphWeightRange(packedWeights, resources.maximumBaseMagnitude, resources.maximumDeltaMagnitude);
    const packedPalette = paletteChanged ? packJointPalette(dynamics.palette) : undefined;
    if (packedPalette && packedPalette.byteLength !== resources.jointCount * 112) throw new Error("Joint count cannot change without a source update.");
    const nextWeights = morphChanged ? flip(resources.activeMorphWeights) : resources.activeMorphWeights;
    const nextPalette = paletteChanged ? flip(resources.activePalette) : resources.activePalette;
    if (packedWeights) this.session.device.queue.writeBuffer(resources.morphWeights[nextWeights], 0, packedWeights);
    if (packedPalette) this.session.device.queue.writeBuffer(resources.palettes[nextPalette], 0, packedPalette);
    const bindGroup = this.binding(resources.vertices, resources.deltas, resources.morphWeights[nextWeights], resources.influences,
      resources.palettes[nextPalette], resources.output, resources.uniform);
    resources.bindGroup = bindGroup; resources.activeMorphWeights = nextWeights; resources.activePalette = nextPalette; resources.dynamics = dynamics;
    return true;
  }

  encode(encoder: GPUCommandEncoder): GpuMorphSkinningResult {
    this.assertReady(); const resources = this.resources;
    if (!resources) throw new Error("Fused morph skinning source is not prepared.");
    const pass = encoder.beginComputePass({ label: "Deep fused morph skinning" }); pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, resources.bindGroup); pass.dispatchWorkgroups(Math.ceil(resources.vertexCount / GPU_MORPH_SKINNING_WORKGROUP_SIZE)); pass.end();
    return Object.freeze({ output: resources.output, vertexCount: resources.vertexCount, outputStride: GPU_MORPH_SKINNING_OUTPUT_STRIDE,
      hasNormals: (resources.flags & 1) !== 0, hasTangents: (resources.flags & 2) !== 0,
      morphSourceRevision: resources.sources.morph.revision, skinningSourceRevision: resources.sources.skinning.revision,
      morphWeightsRevision: resources.dynamics.morphWeights.revision, paletteRevision: resources.dynamics.palette.revision });
  }

  dispose(): void { if (this.disposed) return; this.disposed = true; if (this.resources) this.release(this.resources); this.resources = undefined; }

  private binding(vertices: GPUBuffer, deltas: GPUBuffer, weights: GPUBuffer, influences: GPUBuffer,
    palette: GPUBuffer, output: GPUBuffer, uniform: GPUBuffer): GPUBindGroup {
    return this.session.device.createBindGroup({ label: "Deep fused morph skinning bindings", layout: this.layout, entries: [
      { binding: 0, resource: { buffer: vertices } }, { binding: 1, resource: { buffer: deltas } },
      { binding: 2, resource: { buffer: weights } }, { binding: 3, resource: { buffer: influences } },
      { binding: 4, resource: { buffer: palette } }, { binding: 5, resource: { buffer: output } },
      { binding: 6, resource: { buffer: uniform } },
    ] });
  }
  private assertReady(): void {
    if (this.disposed) throw new Error("GPU morph skinner is disposed.");
    if (this.session.state !== "ready") { if (this.resources) this.release(this.resources); this.resources = undefined;
      throw new Error("GPU session is not ready for fused morph skinning."); }
  }
  private release(resources: FusedResources): void {
    for (const buffer of [resources.vertices, resources.deltas, resources.influences, resources.output,
      ...resources.morphWeights, ...resources.palettes, resources.uniform]) this.session.release(buffer);
  }
}

function validateCapacity(device: GPUDevice, input: PreparedMorphSkinningInput): void {
  const limit = Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize);
  if (Math.max(input.vertices.byteLength, input.deltas.byteLength, input.influences.byteLength, input.joints.byteLength,
    input.morphWeights.byteLength, input.vertexCount * GPU_MORPH_SKINNING_OUTPUT_STRIDE) > limit) throw new Error("Fused deformation buffers exceed device limits.");
  if (Math.ceil(input.vertexCount / GPU_MORPH_SKINNING_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension) {
    throw new Error("Fused deformation dispatch exceeds device limits.");
  }
}
function compareStatic(next: { revision: number }, current: { revision: number }, label: string): void {
  if (next.revision < current.revision) throw new Error(`Stale ${label} source revision.`);
  if (next.revision === current.revision && next !== current) throw new Error(`${label} source changed without a revision.`);
}
function compareDynamic(next: { revision: number }, current: { revision: number }, label: string): boolean {
  if (next.revision < current.revision) throw new Error(`Stale ${label} revision.`);
  if (next.revision === current.revision) { if (next !== current) throw new Error(`${label} changed without a revision.`); return false; }
  return true;
}
function pair(factory: (index: number) => GPUBuffer): [GPUBuffer, GPUBuffer] { return [factory(0), factory(1)]; }
function flip(value: 0 | 1): 0 | 1 { return value === 0 ? 1 : 0; }

export { cpuDeformMorphSkinVertices, prepareMorphSkinningInput } from "./gpuMorphSkinningPacking.js";
export { GPU_MORPH_SKINNING_INFLUENCE_STRIDE, GPU_MORPH_SKINNING_OUTPUT_STRIDE,
  GPU_MORPH_SKINNING_WGSL, GPU_MORPH_SKINNING_WORKGROUP_SIZE } from "./gpuMorphSkinningWgsl.js";
export type { GpuMorphSkinningResult, MorphSkinningDynamics, MorphSkinningSources,
  PreparedMorphSkinningInput } from "./gpuMorphSkinningTypes.js";
