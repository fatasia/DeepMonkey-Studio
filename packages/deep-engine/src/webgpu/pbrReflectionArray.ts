import type { DeviceSession } from "./deviceSession.js";
import type { StudioEnvironment } from "./studioEnvironment.js";
import { createAdmittedTexture } from "./resourceAdmission.js";
import { uploadBuffer } from "./meshBuffers.js";

interface ReflectionArray { readonly environment: StudioEnvironment; readonly view: GPUTextureView;
  readonly metadata: GPUBuffer; readonly owned?: GPUTexture }

/** Exact mip copies, retaining three original LOD ranges in one sampled binding. */
export class PbrReflectionArray {
  private current: ReflectionArray | undefined;
  constructor(private readonly session: DeviceSession) {}
  get(environment: StudioEnvironment): ReflectionArray {
    if (this.current?.environment === environment) return this.current;
    const sources = [environment, environment.reflectionProbes?.[0]?.environment ?? environment,
      environment.reflectionProbes?.[1]?.environment ?? environment];
    const textures = sources.map(source => source.specularTexture);
    for (const texture of textures) {
      if (!texture || texture.format !== "rgba16float" || texture.width !== texture.height
        || texture.depthOrArrayLayers !== 6 || !(texture.usage & GPUTextureUsage.COPY_SRC)) {
        throw new Error("Advanced reflection packing requires owned copyable rgba16float cubes.");
      }
    }
    const concrete = textures as GPUTexture[], size = Math.max(...concrete.map(texture => texture.width));
    const offsets = concrete.map(texture => Math.log2(size / texture.width));
    if (!offsets.every(Number.isSafeInteger)) throw new Error("Reflection cube sizes require exact power-of-two mip offsets.");
    const shared = concrete.every(texture => texture === concrete[0]);
    let owned: GPUTexture | undefined, metadata: GPUBuffer | undefined;
    try {
      if (!shared) {
        const levels = Math.max(...concrete.map((texture, index) => offsets[index]! + texture.mipLevelCount));
        owned = createAdmittedTexture(this.session, { label: "Deep compact reflection cubes", size: [size,size,18],
          mipLevelCount: levels, format: "rgba16float", usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
        const encoder = this.session.device.createCommandEncoder({ label: "Deep exact reflection mip packing" });
        concrete.forEach((texture,index) => {
          for (let level=0; level<texture.mipLevelCount; level++) {
            const dimension = Math.max(1,texture.width >> level);
            encoder.copyTextureToTexture({ texture, mipLevel: level },
              { texture: owned!, mipLevel: level+offsets[index]!, origin: [0,0,index*6] }, [dimension,dimension,6]);
          }
        });
        this.session.device.queue.submit([encoder.finish()]);
      }
      const data = new Float32Array(12);
      concrete.forEach((texture,index) => data.set([texture.mipLevelCount-1, shared ? 0 : offsets[index]!, shared ? 0 : index,0],index*4));
      metadata = uploadBuffer(this.session,"Deep compact reflection LOD ranges",data,GPUBufferUsage.UNIFORM);
      const next: ReflectionArray = { environment, view: (owned ?? concrete[0]!).createView({ dimension:"cube-array" }),
        metadata, ...(owned ? { owned } : {}) };
      const previous=this.current; this.current=next;
      if(previous) { this.session.release(previous.metadata); if(previous.owned)this.session.release(previous.owned); }
      return next;
    } catch(error) {
      if(metadata)this.session.release(metadata); if(owned)this.session.release(owned); throw error;
    }
  }
}

/** Only the advanced source/layout changes; stock WGSL stays byte-identical. */
export function composeReflectionArrayShader(source: string): string {
  return source
    .replace("@group(0) @binding(1) var shadowMap: texture_depth_2d;","")
    .replace("@group(0) @binding(2) var shadowSampler: sampler_comparison;","")
    .replace("@group(0) @binding(3) var specularEnvironment: texture_cube<f32>;",
      "@group(0) @binding(3) var specularEnvironment: texture_cube_array<f32>;\n@group(0) @binding(16) var<uniform> deepReflectionArrayMetadata: array<vec4f,3>;")
    .replace("@group(0) @binding(9) var primaryReflectionEnvironment: texture_cube<f32>;","")
    .replace("@group(0) @binding(10) var secondaryReflectionEnvironment: texture_cube<f32>;","")
    .replaceAll("f32(textureNumLevels(specularEnvironment) - 1u)","deepReflectionArrayMetadata[0].x")
    .replaceAll("f32(textureNumLevels(primaryReflectionEnvironment) - 1u)","deepReflectionArrayMetadata[1].x")
    .replaceAll("f32(textureNumLevels(secondaryReflectionEnvironment) - 1u)","deepReflectionArrayMetadata[2].x")
    .replaceAll("textureSampleLevel(specularEnvironment, environmentSampler, reflection, lod)",
      "textureSampleLevel(specularEnvironment, environmentSampler, reflection, i32(deepReflectionArrayMetadata[0].z), lod + deepReflectionArrayMetadata[0].y)")
    .replaceAll("textureSampleLevel(primaryReflectionEnvironment, environmentSampler, direction, lod)",
      "textureSampleLevel(specularEnvironment, environmentSampler, direction, i32(deepReflectionArrayMetadata[1].z), lod + deepReflectionArrayMetadata[1].y)")
    .replaceAll("textureSampleLevel(secondaryReflectionEnvironment, environmentSampler, direction, lod)",
      "textureSampleLevel(specularEnvironment, environmentSampler, direction, i32(deepReflectionArrayMetadata[2].z), lod + deepReflectionArrayMetadata[2].y)");
}
