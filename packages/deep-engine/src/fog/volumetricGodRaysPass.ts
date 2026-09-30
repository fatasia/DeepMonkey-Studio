/// <reference types="@webgpu/types" />
import { createAdmittedBuffer, createAdmittedTexture } from "../webgpu/resourceAdmission.js";
import { runResourceCleanup } from "../webgpu/resourceCleanup.js";
import { RendererDeviceEpoch } from "../webgpu/rendererDeviceEpoch.js";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import type { PbrTransientTexturePool } from "../webgpu/pbrTransientTexturePool.js";
import { GOD_RAYS_MAX_DISTANCE_CAP, GOD_RAYS_STRENGTH_CAP } from "../lighting/volumetricGodRays.js";
import { DEEP_GOD_RAYS_WORKGROUP_SIZE } from "../lighting/volumetricGodRaysWgsl.js";
import { CASCADED_SHADOW_UNIFORM_BYTES } from "../shadows/cascadedShadowShader.js";
import { validateVolumetricFogOptions, volumetricFogHalfSize } from "./volumetricFogPassCpu.js";
import { VOLUMETRIC_FOG_SCATTER_FORMAT, type VolumetricFogSource, type VolumetricFogPassResult } from "./volumetricFogPassTypes.js";
import { GOD_RAYS_HOST_PARAMETER_BYTES, VOLUMETRIC_GOD_RAYS_CSM_WGSL } from "./volumetricGodRaysPassWgsl.js";
import type { GodRaysShadowSource, VolumetricGodRaysPassOptions } from "./volumetricGodRaysPassTypes.js";

interface Binding { depth: GPUTexture; scatter: GPUTexture; group: GPUBindGroup }
interface ShadowBinding { source: GodRaysShadowSource; group: GPUBindGroup }
/** One bounded half-resolution march in the existing volumetric fog chain. */
export class VolumetricGodRaysPass {
  private readonly epoch: RendererDeviceEpoch;
  private readonly layout: GPUBindGroupLayout;
  private readonly shadowLayout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private parameters: GPUBuffer | undefined;
  private scatter: GPUTexture | undefined;
  private bindings: Binding[] = [];
  private shadowBindings: ShadowBinding[] = [];
  private poolEpoch = -1;
  private disposed = false;

  constructor(private readonly session: DeviceSession, private readonly pool?: PbrTransientTexturePool) {
    this.epoch = new RendererDeviceEpoch(session.device); this.assertUsable();
    const device = session.device, visibility = GPUShaderStage.COMPUTE;
    this.layout = device.createBindGroupLayout({ label: "God rays march source", entries: [
      { binding: 0, visibility, texture: { sampleType: "unfilterable-float" } },
      { binding: 2, visibility, buffer: { type: "read-only-storage", minBindingSize: GOD_RAYS_HOST_PARAMETER_BYTES } },
      { binding: 3, visibility, storageTexture: { access: "write-only", format: VOLUMETRIC_FOG_SCATTER_FORMAT } },
    ] });
    this.shadowLayout = device.createBindGroupLayout({ label: "God rays borrowed CSM", entries: [
      { binding: 0, visibility, buffer: { type: "uniform", minBindingSize: CASCADED_SHADOW_UNIFORM_BYTES } },
      { binding: 1, visibility, texture: { sampleType: "depth", viewDimension: "2d-array" } },
      { binding: 2, visibility, sampler: { type: "comparison" } },
    ] });
    const module = device.createShaderModule({ label: "Canonical god rays with production CSM", code: VOLUMETRIC_GOD_RAYS_CSM_WGSL });
    this.pipeline = device.createComputePipeline({ label: "Half-resolution god rays", layout: device.createPipelineLayout({
      bindGroupLayouts: [this.layout, this.shadowLayout] }), compute: { module, entryPoint: "marchVolumetricGodRays" } });
  }

  encode(encoder: GPUCommandEncoder, source: VolumetricFogSource, shadows: GodRaysShadowSource,
    options: VolumetricGodRaysPassOptions): VolumetricFogPassResult {
    this.assertUsable(); const device = this.session.device;
    validateVolumetricFogOptions(options);
    if (options.maxDistance > GOD_RAYS_MAX_DISTANCE_CAP || !Number.isFinite(options.strength) || options.strength < 0 || options.strength > GOD_RAYS_STRENGTH_CAP)
      throw new RangeError("God rays distance or strength exceeds its budget.");
    if (options.viewToWorld.length !== 16 || Array.from(options.viewToWorld).some(value => !Number.isFinite(value) || !Number.isFinite(Math.fround(value))))
      throw new TypeError("God rays requires a finite view-to-world matrix.");
    const depth = source.depth;
    if (source.depthEncoding !== "linear-view-depth-positive" || !Number.isSafeInteger(source.revision) || source.revision < 0
      || depth.format !== "r32float" || depth.dimension !== "2d" || depth.depthOrArrayLayers !== 1 || depth.sampleCount !== 1
      || !(depth.usage & GPUTextureUsage.TEXTURE_BINDING)) throw new TypeError("God rays requires current single-layer positive linear depth.");
    const [width, height] = volumetricFogHalfSize(depth.width, depth.height);
    if (depth.width > device.limits.maxTextureDimension2D || depth.height > device.limits.maxTextureDimension2D
      || Math.ceil(width / DEEP_GOD_RAYS_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension
      || Math.ceil(height / DEEP_GOD_RAYS_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension)
      throw new RangeError("God rays source exceeds device limits.");
    if (this.pool && !this.pool.frameOpen) throw new Error("God rays requires an open transient frame.");
    if (this.pool && this.poolEpoch !== this.pool.epoch) { this.poolEpoch = this.pool.epoch; this.bindings = []; }
    const handle = this.pool?.acquire({ resourceId: "volumetric-fog-scatter", width, height, sampleCount: 1,
      format: VOLUMETRIC_FOG_SCATTER_FORMAT, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    let candidate: GPUTexture | undefined;
    try {
      let scatter = handle?.texture ?? this.scatter;
      if (!scatter || scatter.width !== width || scatter.height !== height) {
        candidate = createAdmittedTexture(this.session, { label: "God rays scatter", size: { width, height },
          format: VOLUMETRIC_FOG_SCATTER_FORMAT, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
        scatter = candidate;
      }
      this.parameters ??= createAdmittedBuffer(this.session, { label: "God rays host parameters", size: GOD_RAYS_HOST_PARAMETER_BYTES,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      let binding = this.bindings.find(item => item.depth === depth && item.scatter === scatter)?.group;
      if (!binding) {
        binding = device.createBindGroup({ layout: this.layout, entries: [
          { binding: 0, resource: depth.createView() }, { binding: 2, resource: { buffer: this.parameters } },
          { binding: 3, resource: handle?.view ?? scatter.createView() },
        ] });
        this.bindings.push({ depth, scatter, group: binding }); if (this.bindings.length > 4) this.bindings.shift();
      }
      let shadow = this.shadowBindings.find(item => item.source.uniform === shadows.uniform && item.source.view === shadows.view
        && item.source.sampler === shadows.sampler)?.group;
      if (!shadow) {
        shadow = device.createBindGroup({ layout: this.shadowLayout, entries: [
          { binding: 0, resource: { buffer: shadows.uniform } }, { binding: 1, resource: shadows.view }, { binding: 2, resource: shadows.sampler },
        ] });
        this.shadowBindings.push({ source: shadows, group: shadow }); if (this.shadowBindings.length > 2) this.shadowBindings.shift();
      }
      device.queue.writeBuffer(this.parameters, 0, packGodRaysHostParameters(depth.width, depth.height, options, shadows.enabled));
      const pass = encoder.beginComputePass({ label: "Deep volumetric god rays march" });
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, binding); pass.setBindGroup(1, shadow);
      pass.dispatchWorkgroups(Math.ceil(width / DEEP_GOD_RAYS_WORKGROUP_SIZE), Math.ceil(height / DEEP_GOD_RAYS_WORKGROUP_SIZE)); pass.end();
      if (candidate) { if (this.scatter) this.session.release(this.scatter); this.scatter = candidate; candidate = undefined; }
      return Object.freeze({ texture: scatter, format: VOLUMETRIC_FOG_SCATTER_FORMAT, width, height,
        sourceWidth: depth.width, sourceHeight: depth.height, revision: source.revision, updated: true, passCount: 1 });
    } finally { if (candidate) this.session.release(candidate); if (handle) this.pool!.release(handle); }
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    const parameters = this.parameters, scatter = this.scatter;
    this.parameters = undefined; this.scatter = undefined; this.bindings = []; this.shadowBindings = [];
    runResourceCleanup("God rays disposal failed", [() => { if (parameters) this.session.release(parameters); },
      () => { if (scatter) this.session.release(scatter); }]);
  }
  private assertUsable(): void {
    if (this.disposed) throw new Error("God rays pass is disposed.");
    this.epoch.assertCurrent(this.session.device);
    if (this.session.state !== "ready") throw new Error("GPU session is not ready for god rays.");
  }
}

export function packGodRaysHostParameters(width: number, height: number, options: VolumetricGodRaysPassOptions,
  shadowsEnabled: boolean): ArrayBuffer {
  const buffer = new ArrayBuffer(GOD_RAYS_HOST_PARAMETER_BYTES), uints = new Uint32Array(buffer), floats = new Float32Array(buffer);
  uints.set([width, height, Math.ceil(width / 2), Math.ceil(height / 2)]);
  floats.set([Math.tan(options.verticalFovRadians / 2), width / height], 4);
  floats.set([options.medium.baseExtinction, options.medium.scaleHeight, options.medium.anisotropy, options.medium.albedo], 8);
  floats.set([...options.light.direction, options.maxDistance], 12);
  floats.set([...options.light.radiance, options.strength], 16);
  uints.set([options.steps, shadowsEnabled ? 1 : 0], 32); floats.set(Array.from(options.viewToWorld), 36);
  return buffer;
}
