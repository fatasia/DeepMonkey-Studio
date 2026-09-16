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
type GiFallback = ProbeClipmapLightingBinding & { readonly texture: GPUTexture; readonly metadata: GPUBuffer };

/** Caches group-3 bindings until the assigner changes an underlying buffer capacity. */
export class ForwardPlusPbrLightingBindings {
  readonly layout: GPUBindGroupLayout;
  private readonly localShadow: LocalSpotShadowBindings;
  private readonly fallback?: { readonly uniform: GPUBuffer; readonly texture: GPUTexture };
  private readonly giFallback: GiFallback;
  private probe: ProbeClipmapLightingBinding | undefined;
  private signature: readonly object[] | undefined;
  private cached: GPUBindGroup | undefined;
  private disposed = false;

  constructor(private readonly session: LightingSession, localShadow?: LocalSpotShadowBindings) {
    this.assertReady();
    let fallback: { readonly uniform: GPUBuffer; readonly texture: GPUTexture } | undefined, giFallback: GiFallback | undefined;
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
        buffer: { type: "uniform", minBindingSize: DEEP_GI_TEXTURE_LEVEL_METADATA_BYTES } });
      this.giFallback = giFallback = createGiFallback(session);
      this.layout = session.device.createBindGroupLayout({ label: "Deep Forward+ PBR lighting group 3", entries });
    } catch (error) {
      const cleanup = [...(fallback ? [() => session.release(fallback!.uniform), () => session.release(fallback!.texture)] : []),
        ...(giFallback ? [() => session.release(giFallback!.metadata), () => session.release(giFallback!.texture)] : [])];
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

  bind(resources: ForwardPlusClusterResources): ForwardPlusPbrBindingResult {
    this.assertReady();
    const probe = this.probe ?? this.giFallback;
    const clusterBuffers = [resources.clusterParameterBuffer, resources.directionalLightBuffer, resources.pointLightBuffer,
      resources.spotLightBuffer, resources.clusterHeaderBuffer, resources.clusterLightIndexBuffer] as const;
    const signature = [...clusterBuffers,
      probe.view, probe.sampler, probe.levelMetadataBuffer] as const;
    if (!this.cached || !this.signature || !signature.every((buffer, index) => buffer === this.signature![index])) {
      const entries: GPUBindGroupEntry[] = clusterBuffers.map((buffer, binding) => ({ binding, resource: { buffer } }));
      entries.push({ binding: 6, resource: { buffer: this.localShadow.uniform } },
        { binding: 7, resource: this.localShadow.atlasView }, { binding: 8, resource: this.localShadow.sampler },
        { binding: 9, resource: probe.view }, { binding: 10, resource: probe.sampler },
        { binding: 11, resource: { buffer: probe.levelMetadataBuffer } });
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
