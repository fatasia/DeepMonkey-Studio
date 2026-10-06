/// <reference types="@webgpu/types" />
import { createAdmittedBuffer } from "../webgpu/resourceAdmission.js";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import type { PbrTransientTextureHandle, PbrTransientTexturePool } from "../webgpu/pbrTransientTexturePool.js";
import { PROJECTED_TEXTURE_WORKGROUP_SIZE, PROJECTED_TEXTURE_LIGHT_WGSL } from "./projectedTextureWgsl.js";
import { packProjectedTextureParameters } from "./projectedTextureCpu.js";
import { PROJECTED_TEXTURE_COLOR_FORMAT, PROJECTED_TEXTURE_DEPTH_FORMAT, PROJECTED_TEXTURE_INPUT_COLOR_FORMAT,
  PROJECTED_TEXTURE_NORMAL_FORMAT, type ProjectedTextureOptions, type ProjectedTextureResult,
  type ProjectedTextureSource } from "./projectedTextureTypes.js";

const PARAMETER_BYTES = 128;
interface PooledBindings {
  readonly color: GPUTexture; readonly depth: GPUTexture; readonly normal: GPUTexture; readonly gobo: GPUTextureView;
  readonly output: GPUTexture;
  readonly binding: GPUBindGroup;
}

/**
 * P2 投影纹理光 pass(three r186 ProjectorLight gobo 纹理半部;SSR 域邻接,输出插在
 * SSGI 之后、SSR 之前——SSR composite 在命中 UV 采色即携带投影贡献,反射链路命中点
 * 的投影纹理贡献由此成立)。单 pass 全分辨率解析求值;全 transient pool 路径(生产
 * 帧池恒在;构造要求 pool,拒绝隐式自有分配)。features 关闭时运行时不构建。
 */
export class ProjectedTexturePass {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private disposed = false;
  private pooledParameters: GPUBuffer | undefined; private pooledEpoch = -1;
  private pooledBindings: PooledBindings[] = [];
  private pooledSource: ProjectedTextureSource | undefined;
  private samplerCache: GPUSampler | undefined;

  constructor(private readonly session: DeviceSession, private readonly pool: PbrTransientTexturePool) {
    this.assertReady();
    const device = session.device;
    const module = device.createShaderModule({ label: "Deep projected texture light WGSL", code: PROJECTED_TEXTURE_LIGHT_WGSL });
    this.layout = device.createBindGroupLayout({ label: "Deep projected texture layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: PARAMETER_BYTES } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: PROJECTED_TEXTURE_COLOR_FORMAT } },
    ] });
    this.pipeline = device.createComputePipeline({ label: "Deep projected texture light pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module, entryPoint: "applyProjectedTextureLight" } });
  }

  encode(encoder: GPUCommandEncoder, source: ProjectedTextureSource, options: ProjectedTextureOptions): ProjectedTextureResult {
    this.assertUsable();
    if (!this.pool.frameOpen) throw new Error("Projected texture transient textures require an open frame scope.");
    const request = validateRequest(this.session.device, source, options);
    if (this.pooledEpoch !== this.pool.epoch) {
      this.pooledEpoch = this.pool.epoch; this.pooledBindings = []; this.pooledSource = undefined;
    }
    const previous = this.pooledSource;
    if (previous && source.revision < previous.revision) throw new Error("Stale projected texture source revision.");
    if (previous && source.revision === previous.revision
      && (source.depth !== previous.depth || source.normal !== previous.normal || source.color !== previous.color
        || source.gobo !== previous.gobo)) {
      throw new Error("Projected texture source textures changed without a revision.");
    }
    const handles: PbrTransientTextureHandle[] = [];
    try {
      // 输出带 COPY_SRC:present-color 读回链在投影纹理为链尾效果时落在本输出上(与 ssr-hdr/ssgi-hdr 合同对齐)。
      const output = this.pool.acquire({ resourceId: "projected-texture-hdr", width: request.width,
        height: request.height, sampleCount: 1, format: PROJECTED_TEXTURE_COLOR_FORMAT,
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
      handles.push(output);
      let bindings = this.pooledBindings.find(item => item.color === source.color && item.depth === source.depth
        && item.normal === source.normal && item.gobo === source.gobo && item.output === output.texture);
      if (!bindings) {
        const binding = this.session.device.createBindGroup({ label: "Deep projected texture bindings",
          layout: this.layout, entries: [
            { binding: 0, resource: source.color.createView({ format: PROJECTED_TEXTURE_INPUT_COLOR_FORMAT,
              dimension: "2d", baseMipLevel: 0, mipLevelCount: 1 }) },
            { binding: 1, resource: source.depth.createView({ format: PROJECTED_TEXTURE_DEPTH_FORMAT,
              dimension: "2d", baseMipLevel: 0, mipLevelCount: 1 }) },
            { binding: 2, resource: source.normal.createView({ format: PROJECTED_TEXTURE_NORMAL_FORMAT,
              dimension: "2d", baseMipLevel: 0, mipLevelCount: 1 }) },
            { binding: 3, resource: source.gobo },
            { binding: 4, resource: { buffer: this.parameters() } },
            { binding: 5, resource: this.sampler() },
            { binding: 6, resource: output.view }] });
        bindings = { color: source.color, depth: source.depth, normal: source.normal, gobo: source.gobo,
          output: output.texture, binding };
        this.pooledBindings.push(bindings);
        if (this.pooledBindings.length > 4) this.pooledBindings.shift();
      }
      this.session.device.queue.writeBuffer(this.parameters(), 0,
        packProjectedTextureParameters(toCpuFrame(source), request.width, request.height, options.verticalFovRadians));
      options.passTiming?.beginMarker(encoder, "projected-texture-light");
      const dispatch = encoder.beginComputePass({ label: "Deep projected texture light" });
      dispatch.setPipeline(this.pipeline); dispatch.setBindGroup(0, bindings.binding);
      dispatch.dispatchWorkgroups(Math.ceil(request.width / PROJECTED_TEXTURE_WORKGROUP_SIZE),
        Math.ceil(request.height / PROJECTED_TEXTURE_WORKGROUP_SIZE));
      dispatch.end();
      options.passTiming?.endMarker(encoder, "projected-texture-light");
      this.pooledSource = source;
      return Object.freeze({ texture: output.texture, format: PROJECTED_TEXTURE_COLOR_FORMAT,
        width: request.width, height: request.height, revision: source.revision, updated: true, passCount: 1 });
    } finally { for (const handle of handles) this.pool.release(handle); }
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    if (this.pooledParameters) this.session.release(this.pooledParameters);
    this.pooledParameters = undefined; this.pooledBindings = []; this.pooledSource = undefined;
  }

  private parameters(): GPUBuffer {
    return this.pooledParameters ??= createAdmittedBuffer(this.session,
      { label: "Deep projected texture parameters", size: PARAMETER_BYTES,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }
  private sampler(): GPUSampler {
    return this.samplerCache ??= this.session.device.createSampler(
      { label: "Deep projected texture bilinear sampler", magFilter: "linear", minFilter: "linear" });
  }
  private assertReady(): void { if (this.session.state !== "ready") throw new Error("GPU session is not ready for projected texture light."); }
  private assertUsable(): void {
    if (this.disposed) throw new Error("Projected texture pass is disposed.");
    if (this.session.state !== "ready") { this.pooledBindings = []; this.pooledSource = undefined;
      throw new Error("GPU session is not ready for projected texture light."); }
  }
}

function toCpuFrame(source: ProjectedTextureSource): {
  viewToProjector: readonly number[]; positionView: readonly [number, number, number];
  intensity: number; color: readonly [number, number, number]; range: number; edgeSoften: number;
} {
  if (source.viewToProjector.length !== 16) throw new Error("Projected texture viewToProjector must carry 16 floats.");
  return { viewToProjector: Array.from(source.viewToProjector), positionView: source.positionView,
    intensity: source.intensity, color: source.lightColor, range: source.range, edgeSoften: source.edgeSoften };
}

function validateRequest(device: GPUDevice, source: ProjectedTextureSource, options: ProjectedTextureOptions): Request {
  if (source.depthEncoding !== "linear-view-depth-positive") throw new Error("Projected texture requires explicit positive linear view depth; standard/reversed device depth must be linearized first.");
  if (source.normalSpace !== "view") throw new Error("Projected texture normals must be declared in view space.");
  if (source.colorEncoding !== "linear-hdr") throw new Error("Projected texture color input must be linear HDR.");
  if (!Number.isSafeInteger(source.revision) || source.revision < 0) throw new Error("Projected texture source revision must be a nonnegative safe integer.");
  validateTexture(source.depth, PROJECTED_TEXTURE_DEPTH_FORMAT, "depth");
  validateTexture(source.normal, PROJECTED_TEXTURE_NORMAL_FORMAT, "normal");
  validateTexture(source.color, PROJECTED_TEXTURE_INPUT_COLOR_FORMAT, "color");
  if (source.depth.width !== source.normal.width || source.depth.height !== source.normal.height
    || source.depth.width !== source.color.width || source.depth.height !== source.color.height) {
    throw new Error("Projected texture depth, normal, and color dimensions must match.");
  }
  if (source.depth.width > device.limits.maxTextureDimension2D || source.depth.height > device.limits.maxTextureDimension2D) {
    throw new Error("Projected texture source dimensions exceed device limits.");
  }
  if (![...source.positionView, ...source.lightColor, source.intensity, source.range, source.edgeSoften]
    .every(value => Number.isFinite(value))) {
    throw new Error("Projected texture frame parameters must be finite.");
  }
  if (source.intensity < 0 || source.range <= 0 || source.edgeSoften < 0 || source.edgeSoften > 0.5) {
    throw new Error("Projected texture frame parameters out of range.");
  }
  if (Math.ceil(source.depth.width / PROJECTED_TEXTURE_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension
    || Math.ceil(source.depth.height / PROJECTED_TEXTURE_WORKGROUP_SIZE) > device.limits.maxComputeWorkgroupsPerDimension) {
    throw new Error("Projected texture dispatch exceeds device workgroup limits.");
  }
  return { width: source.depth.width, height: source.depth.height };
}
interface Request { readonly width: number; readonly height: number }

function validateTexture(texture: GPUTexture, format: GPUTextureFormat, name: string): void {
  if (texture.format !== format) throw new Error(`Projected texture ${name} format must be ${format}.`);
  if (texture.dimension !== "2d" || texture.depthOrArrayLayers !== 1 || texture.sampleCount !== 1) {
    throw new Error(`Projected texture ${name} must be a non-multisampled single-layer 2D texture.`);
  }
  if ((texture.usage & GPUTextureUsage.TEXTURE_BINDING) === 0) throw new Error(`Projected texture ${name} requires TEXTURE_BINDING usage.`);
  if (!Number.isInteger(texture.width) || !Number.isInteger(texture.height) || texture.width < 1 || texture.height < 1) {
    throw new Error(`Projected texture ${name} dimensions must be positive integers.`);
  }
}
