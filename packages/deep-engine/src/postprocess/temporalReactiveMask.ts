/// <reference types="@webgpu/types" />
import { createAdmittedTexture } from "../webgpu/resourceAdmission.js";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { TEMPORAL_REACTIVE_MASK_FORMAT } from "./temporalAaTypes.js";

export const TEMPORAL_REACTIVE_MASK_WGSL = /* wgsl */ `
struct MaskParams {
  size: vec2<u32>,
};
@group(0) @binding(0) var compositedColor: texture_2d<f32>;
@group(0) @binding(1) var opaqueColor: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> maskParams: MaskParams;
@group(0) @binding(3) var outputMask: texture_storage_2d<r8unorm, write>;

@compute @workgroup_size(8, 8)
fn extractReactiveMask(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= maskParams.size.x || id.y >= maskParams.size.y) { return; }
  let coordinate = vec2<i32>(id.xy);
  // Weighted-OIT composite algebra: composited.a = coverage + opaque.a * (1 - coverage),
  // so coverage = (composited.a - opaque.a) / (1 - opaque.a); an opaque alpha at 1
  // carries no coverage signal and must degrade to zero instead of dividing by ~zero.
  let compositedAlpha = textureLoad(compositedColor, coordinate, 0).a;
  let opaqueAlpha = textureLoad(opaqueColor, coordinate, 0).a;
  let coverage = clamp((compositedAlpha - opaqueAlpha) / max(1.0 - opaqueAlpha, 1e-3), 0.0, 1.0);
  textureStore(outputMask, coordinate, vec4f(coverage));
}
`;

/**
 * Reactive coverage from the weighted-OIT composite alpha algebra (inverse of
 * `coverage + opaque.a * revealage`); guards the degenerate opaque-alpha-1 case to 0.
 */
export function reactiveCoverageFromAlphas(compositedAlpha: number, opaqueAlpha: number): number {
  if (![compositedAlpha, opaqueAlpha].every(value => Number.isFinite(value)) || compositedAlpha < 0 || opaqueAlpha < 0
    || compositedAlpha > 1.001 || opaqueAlpha > 1.001) throw new Error("Reactive coverage alphas are invalid.");
  const denominator = Math.max(1 - opaqueAlpha, 1e-3);
  return Math.max(0, Math.min(1, (compositedAlpha - opaqueAlpha) / denominator));
}

export interface ReactiveMaskSource {
  readonly compositedColor: GPUTexture;
  readonly opaqueColor: GPUTexture;
}

export interface ReactiveMaskResult {
  readonly texture: GPUTexture; readonly format: typeof TEMPORAL_REACTIVE_MASK_FORMAT;
  readonly width: number; readonly height: number;
}

/**
 * Extracts per-pixel reactive coverage (transparent/particle regions) into an
 * r8unorm mask consumable by TemporalAaSource.reactiveMask. Production frames do
 * not encode this pass yet: wiring it into the renderer requires the frame-graph,
 * describePasses and plan-executor declarations (webgpu/ ownership), so the pass is
 * exercised by the GPU sequence harness until that integration slice.
 */
export class TemporalReactiveMaskPass {
  private readonly layout: GPUBindGroupLayout; private readonly pipeline: GPUComputePipeline;
  private output: GPUTexture | undefined; private disposed = false;
  constructor(private readonly session: DeviceSession) {
    if (session.state !== "ready") throw new Error("GPU session is not ready for the reactive mask pass.");
    const device = session.device, module = device.createShaderModule({ label: "Deep temporal reactive mask WGSL", code: TEMPORAL_REACTIVE_MASK_WGSL });
    this.layout = device.createBindGroupLayout({ label: "Deep temporal reactive mask layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 16 } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: TEMPORAL_REACTIVE_MASK_FORMAT } },
    ] });
    this.pipeline = device.createComputePipeline({ label: "Deep temporal reactive mask pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }), compute: { module, entryPoint: "extractReactiveMask" } });
  }

  encode(encoder: GPUCommandEncoder, source: ReactiveMaskSource): ReactiveMaskResult {
    if (this.disposed) throw new Error("Reactive mask pass is disposed.");
    if (this.session.state !== "ready") throw new Error("GPU session is not ready for the reactive mask pass.");
    const { compositedColor, opaqueColor } = source;
    for (const [texture, name] of [[compositedColor, "composited"], [opaqueColor, "opaque"]] as const) {
      if (texture.dimension !== "2d" || texture.sampleCount !== 1 || (texture.usage & GPUTextureUsage.TEXTURE_BINDING) === 0)
        throw new Error(`Invalid reactive mask ${name} texture; expected single-sample 2D TEXTURE_BINDING.`);
      if (texture.width !== compositedColor.width || texture.height !== compositedColor.height) throw new Error("Reactive mask input dimensions must match.");
    }
    const width = compositedColor.width, height = compositedColor.height;
    if (!this.output || this.output.width !== width || this.output.height !== height) {
      const previous = this.output;
      this.output = createAdmittedTexture(this.session, { label: "Deep temporal reactive mask",
        size: [width, height], format: TEMPORAL_REACTIVE_MASK_FORMAT,
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
      if (previous) this.session.release(previous);
    }
    const parameters = this.session.device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    try {
      this.session.device.queue.writeBuffer(parameters, 0, new Uint32Array([width, height, 0, 0]));
      const bindGroup = this.session.device.createBindGroup({ layout: this.layout, entries: [
        { binding: 0, resource: compositedColor.createView() }, { binding: 1, resource: opaqueColor.createView() },
        { binding: 2, resource: { buffer: parameters } }, { binding: 3, resource: this.output!.createView() }] });
      const pass = encoder.beginComputePass({ label: "Deep temporal reactive mask" });
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); pass.end();
      return Object.freeze({ texture: this.output!, format: TEMPORAL_REACTIVE_MASK_FORMAT, width, height });
    } finally { parameters.destroy(); }
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    if (this.output) this.session.release(this.output); this.output = undefined;
  }
}
