/// <reference types="@webgpu/types" />
import type { DeviceSession } from "../webgpu/deviceSession.js";
import type { LocalSpotShadowBindings } from "../webgpu/localSpotShadowRuntime.js";
import { LOCAL_SPOT_SHADOW_UNIFORM_BYTES } from "../shadows/localSpotShadowShader.js";
import { failWithResourceCleanup } from "../webgpu/resourceCleanup.js";
import { FORWARD_PLUS_LIGHTING_BIND_GROUP } from "./clusterAbiWgsl.js";
import type { ForwardPlusClusterResources } from "./clusterCompute.js";
import { DEEP_GI_TEXTURE_LEVEL_METADATA_BYTES } from "./probeClipmapTextureSamplingWgsl.js";

type LightingSession = Pick<DeviceSession, "device" | "state" | "own" | "release">;

export interface ForwardPlusPbrBindingResult {
  readonly group: typeof FORWARD_PLUS_LIGHTING_BIND_GROUP;
  readonly bindGroup: GPUBindGroup;
  readonly layout: GPUBindGroupLayout;
}
export interface ProbeClipmapLightingBinding {
  readonly view: GPUTextureView;
  readonly sampler: GPUSampler;
  readonly levelMetadataBuffer: GPUBuffer;
}
/** C3 面积光 cookie(光斑)纹理;缺省 1×1 白纹理(均匀发射,采样恒等)。 */
export interface AreaCookieBinding {
  readonly view: GPUTextureView;
  readonly sampler: GPUSampler;
}
type GiFallback = ProbeClipmapLightingBinding & { readonly texture: GPUTexture; readonly metadata: GPUBuffer };

/** C3 group-3 面积光绑定槽位(storage 数据 + cookie 纹理/采样器),与 FORWARD_PLUS_PBR_WGSL 逐字互钉。 */
export const FORWARD_PLUS_AREA_DATA_BINDING = 13;
export const FORWARD_PLUS_AREA_COOKIE_TEXTURE_BINDING = 14;
export const FORWARD_PLUS_AREA_COOKIE_SAMPLER_BINDING = 15;

/** Caches group-3 bindings until the assigner changes an underlying buffer capacity. */
export class ForwardPlusPbrLightingBindings {
  readonly layout: GPUBindGroupLayout;
  private readonly localShadow: LocalSpotShadowBindings;
  private readonly fallback?: { readonly uniform: GPUBuffer; readonly texture: GPUTexture };
  private readonly giFallback: GiFallback;
  private readonly cookieFallback: AreaCookieBinding & { readonly texture: GPUTexture };
  private probe: ProbeClipmapLightingBinding | undefined;
  private cookie: AreaCookieBinding | undefined;
  private signature: readonly object[] | undefined;
  private cached: GPUBindGroup | undefined;
  private disposed = false;

  constructor(private readonly session: LightingSession, localShadow?: LocalSpotShadowBindings) {
    this.assertReady();
    let fallback: { readonly uniform: GPUBuffer; readonly texture: GPUTexture } | undefined, giFallback: GiFallback | undefined,
      cookieFallback: (AreaCookieBinding & { readonly texture: GPUTexture }) | undefined;
    try {
      if (localShadow) this.localShadow = localShadow;
      else {
        const uniform = session.own(session.device.createBuffer({ label: "Deep disabled local shadow data",
          size: LOCAL_SPOT_SHADOW_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM }));
        let texture: GPUTexture;
        try { texture = session.own(session.device.createTexture({ label: "Deep disabled local shadow atlas", size: [1, 1],
          format: "depth32float", usage: GPUTextureUsage.TEXTURE_BINDING })); }
        catch (error) { session.release(uniform); throw error; }
        fallback = { uniform, texture }; this.fallback = fallback;
        this.localShadow = Object.freeze({ uniform, atlasView: texture.createView({ dimension: "2d", aspect: "depth-only" }),
          sampler: session.device.createSampler({ compare: "less-equal" }) });
      }
      const entries: GPUBindGroupLayoutEntry[] = [0, 1, 2, 3, 4, 5].map(binding => ({
        binding, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" },
      }));
      entries.push({ binding: 6, visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform", minBindingSize: LOCAL_SPOT_SHADOW_UNIFORM_BYTES } },
      { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d" } },
      { binding: 8, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
      { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d-array" } },
      { binding: 10, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      { binding: 11, visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform", minBindingSize: DEEP_GI_TEXTURE_LEVEL_METADATA_BYTES } },
      { binding: 12, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      // C3:面积光数据 + cookie 纹理/采样器(缺省 1×1 白,均匀发射恒等)。
      { binding: FORWARD_PLUS_AREA_DATA_BINDING, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      { binding: FORWARD_PLUS_AREA_COOKIE_TEXTURE_BINDING, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
      { binding: FORWARD_PLUS_AREA_COOKIE_SAMPLER_BINDING, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } });
      this.giFallback = giFallback = createGiFallback(session);
      this.cookieFallback = cookieFallback = createCookieFallback(session);
      this.layout = session.device.createBindGroupLayout({ label: "Deep Forward+ PBR lighting group 3", entries });
    } catch (error) {
      const cleanup = [...(fallback ? [() => session.release(fallback!.uniform), () => session.release(fallback!.texture)] : []),
        ...(giFallback ? [() => session.release(giFallback!.metadata), () => session.release(giFallback!.texture)] : []),
        ...(cookieFallback ? [() => session.release(cookieFallback!.texture)] : [])];
      if (cleanup.length) failWithResourceCleanup(error, "PBR lighting binding rollback failed.", cleanup);
      throw error;
    }
  }

  get hasProbeClipmap(): boolean { return this.probe !== undefined; }
  setProbeClipmap(binding?: ProbeClipmapLightingBinding): void {
    this.assertReady();
    if (this.probe?.view === binding?.view && this.probe?.sampler === binding?.sampler
      && this.probe?.levelMetadataBuffer === binding?.levelMetadataBuffer) return;
    this.probe = binding; this.signature = undefined; this.cached = undefined;
  }

  /** C3:换面积光 cookie 纹理;undefined 回到 1×1 白缺省(均匀发射)。 */
  setAreaCookie(binding?: AreaCookieBinding): void {
    this.assertReady();
    if (this.cookie?.view === binding?.view && this.cookie?.sampler === binding?.sampler) return;
    this.cookie = binding; this.signature = undefined; this.cached = undefined;
  }

  bind(resources: ForwardPlusClusterResources): ForwardPlusPbrBindingResult {
    this.assertReady();
    const probe = this.probe ?? this.giFallback;
    const cookie = this.cookie ?? this.cookieFallback;
    const clusterBuffers = [resources.clusterParameterBuffer, resources.directionalLightBuffer, resources.pointLightBuffer,
      resources.spotLightBuffer, resources.clusterHeaderBuffer, resources.clusterLightIndexBuffer,
      resources.iesShadingBuffer] as const;
    const signature = [...clusterBuffers, resources.areaLightDataBuffer,
      probe.view, probe.sampler, probe.levelMetadataBuffer, cookie.view, cookie.sampler] as const;
    if (!this.cached || !this.signature || !signature.every((buffer, index) => buffer === this.signature![index])) {
      const entries: GPUBindGroupEntry[] = clusterBuffers.map((buffer, binding) => ({ binding: binding < 6 ? binding : 12, resource: { buffer } }));
      entries.push({ binding: 6, resource: { buffer: this.localShadow.uniform } },
        { binding: 7, resource: this.localShadow.atlasView }, { binding: 8, resource: this.localShadow.sampler },
        { binding: 9, resource: probe.view }, { binding: 10, resource: probe.sampler },
        { binding: 11, resource: { buffer: probe.levelMetadataBuffer } },
        { binding: FORWARD_PLUS_AREA_DATA_BINDING, resource: { buffer: resources.areaLightDataBuffer } },
        { binding: FORWARD_PLUS_AREA_COOKIE_TEXTURE_BINDING, resource: cookie.view },
        { binding: FORWARD_PLUS_AREA_COOKIE_SAMPLER_BINDING, resource: cookie.sampler });
      const bindGroup = this.session.device.createBindGroup({ label: "Deep Forward+ PBR lighting bindings",
        layout: this.layout, entries });
      this.signature = signature; this.cached = bindGroup;
    }
    return { group: FORWARD_PLUS_LIGHTING_BIND_GROUP, bindGroup: this.cached, layout: this.layout };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.signature = undefined; this.cached = undefined;
    this.session.release(this.giFallback.metadata); this.session.release(this.giFallback.texture);
    this.session.release(this.cookieFallback.texture);
    if (this.fallback) { this.session.release(this.fallback.uniform); this.session.release(this.fallback.texture); }
  }

  private assertReady(): void {
    if (this.disposed) throw new Error("Forward+ PBR lighting bindings are disposed.");
    if (this.session.state !== "ready") throw new Error(`Forward+ PBR lighting cannot use a ${this.session.state} GPU session.`);
  }
}

function createGiFallback(session: LightingSession): GiFallback {
  const texture = session.own(session.device.createTexture({ label: "Deep disabled GI volume", size: [1, 1, 1],
    format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING }));
  try {
    const metadata = session.own(session.device.createBuffer({ label: "Deep disabled GI levels",
      size: DEEP_GI_TEXTURE_LEVEL_METADATA_BYTES, usage: GPUBufferUsage.UNIFORM }));
    return Object.freeze({ texture, view: texture.createView({ dimension: "2d-array" }),
      sampler: session.device.createSampler({ magFilter: "linear", minFilter: "linear" }), metadata,
      levelMetadataBuffer: metadata });
  } catch (error) { session.release(texture); throw error; }
}

/** C3 面积光 cookie 缺省:1×1 白纹理(采样恒 (1,1,1),均匀发射,乘法逐位不变)。 */
function createCookieFallback(session: LightingSession): AreaCookieBinding & { readonly texture: GPUTexture } {
  const texture = session.own(session.device.createTexture({ label: "Deep disabled area cookie", size: [1, 1],
    format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING }));
  try {
    return Object.freeze({ texture, view: texture.createView(),
      sampler: session.device.createSampler({ magFilter: "linear", minFilter: "linear" }) });
  } catch (error) { session.release(texture); throw error; }
}
