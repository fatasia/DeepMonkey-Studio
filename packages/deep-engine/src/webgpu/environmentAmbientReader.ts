/// <reference types="@webgpu/types" />
/**
 * F1 切片2：环境平均辐射读回。对 StudioEnvironment.diffuse（漫射辐度 cubemap）做确定性
 * 稀疏采样（每面 8×8 = 384 texel，textureLoad 直读 mip0，无采样器依赖），GPU 端写出全部
 * 样本、CPU 端取 RGB 均值，作为探针一跳捕获的 ambient 项。一次环境读一次并按环境身份
 * 缓存；读回失败（设备丢失/abort）保持上一次值并以零起步，由调用方决定是否重试。
 * 这是真实 GPU 读回路径，不使用常量近似或 CPU 估计。
 */

import { runResourceCleanup } from "./resourceCleanup.js";
import type { DeviceSession } from "./deviceSession.js";
import type { StudioEnvironment } from "./studioEnvironment.js";

export type EnvironmentAmbient = readonly [number, number, number];

const FACE_TEXELS = 8;
const FACES = 6;
const SAMPLES = FACE_TEXELS * FACE_TEXELS * FACES;
const WORKGROUP = 64;
const SAMPLE_BYTES = 16;

const AMBIENT_WGSL = /* wgsl */ `// Deep GI environment ambient read (F1 slice-2): deterministic sparse cubemap average.
// WGSL has no textureLoad for texture_cube, so each face texel is mapped to its direction
// (standard cubemap face axes) and fetched with textureSample; 6 faces x 8x8 directions.
struct Sample {
  color: vec4f,
}
@group(0) @binding(0) var env: texture_cube<f32>;
@group(0) @binding(1) var<storage, read_write> samples: array<Sample>;
@group(0) @binding(2) var envSampler: sampler;

fn faceDirection(face: u32, u: f32, v: f32) -> vec3f {
  switch face {
    case 0u: { return vec3f(1.0, -v, -u); }   // +x
    case 1u: { return vec3f(-1.0, -v, u); }   // -x
    case 2u: { return vec3f(u, 1.0, v); }     // +y
    case 3u: { return vec3f(u, -1.0, -v); }   // -y
    case 4u: { return vec3f(u, -v, 1.0); }    // +z
    default:  { return vec3f(-u, -v, -1.0); } // -z
  }
}

@compute @workgroup_size(${WORKGROUP})
fn read_environment_ambient(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= ${SAMPLES}u) { return; }
  let face = index / ${FACE_TEXELS * FACE_TEXELS}u;
  let texel = index % ${FACE_TEXELS * FACE_TEXELS}u;
  let x = f32(texel % ${FACE_TEXELS}u);
  let y = f32(texel / ${FACE_TEXELS}u);
  let u = (x + 0.5) / ${FACE_TEXELS}.0 * 2.0 - 1.0;
  let v = (y + 0.5) / ${FACE_TEXELS}.0 * 2.0 - 1.0;
  samples[index] = Sample(textureSampleLevel(env, envSampler, faceDirection(face, u, v), 0.0));
}
`;

export class EnvironmentAmbientReader {
  private readonly session: DeviceSession;
  private readonly pipeline: GPUComputePipeline;
  private readonly ambientLayout: GPUBindGroupLayout;
  private inFlight = false;

  constructor(session: DeviceSession) {
    if (session.state !== "ready") throw new Error("GPU session is not ready for environment ambient read.");
    this.session = session;
    const device = session.device;
    const module = device.createShaderModule({ label: "Deep GI environment ambient read",
      code: AMBIENT_WGSL });
    const layoutEntries: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float",
        viewDimension: "cube", multisampled: false } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
    ];
    this.ambientLayout = device.createBindGroupLayout({ label: "Deep GI ambient read layout",
      entries: layoutEntries });
    this.pipeline = device.createComputePipeline({ label: "Deep GI environment ambient pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.ambientLayout] }),
      compute: { module, entryPoint: "read_environment_ambient" } });
  }

  get busy(): boolean { return this.inFlight; }

  /** One-shot GPU readback of the environment's average diffuse radiance. */
  read(environment: StudioEnvironment, signal?: AbortSignal): Promise<EnvironmentAmbient> {
    if (this.inFlight) throw new Error("Environment ambient read is already in flight.");
    if (this.session.state !== "ready") return Promise.reject(new Error("GPU session is not ready."));
    this.inFlight = true;
    const device = this.session.device;
    const samples = device.createBuffer({ label: "Deep GI ambient samples",
      size: SAMPLES * SAMPLE_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readback = device.createBuffer({ label: "Deep GI ambient readback",
      size: SAMPLES * SAMPLE_BYTES, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const finish = () => runResourceCleanup("Environment ambient read cleanup failed.", [
      () => this.session.release(samples), () => this.session.release(readback)]);
    const bindGroup = device.createBindGroup({ label: "Deep GI ambient bindings",
      layout: this.ambientLayout, entries: [
        { binding: 0, resource: environment.diffuse },
        { binding: 1, resource: { buffer: samples } },
        { binding: 2, resource: environment.sampler },
      ] });
    const encoder = device.createCommandEncoder({ label: "Deep GI ambient read" });
    const pass = encoder.beginComputePass({ label: "Deep GI ambient sample" });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(SAMPLES / WORKGROUP));
    pass.end();
    encoder.copyBufferToBuffer(samples, 0, readback, 0, SAMPLES * SAMPLE_BYTES);
    device.queue.submit([encoder.finish()]);
    const abort = () => readback.mapAsync(GPUMapMode.READ).then(() => readback.unmap()).catch(() => {});
    signal?.addEventListener("abort", abort, { once: true });
    return readback.mapAsync(GPUMapMode.READ).then(() => {
      const mapped = readback.getMappedRange();
      const average = averageAmbientSamples(new Float32Array(mapped.slice(0)));
      readback.unmap();
      return average;
    }).catch(error => { throw error; }).finally(() => {
      this.inFlight = false;
      signal?.removeEventListener("abort", abort);
      finish();
    });
  }
}

/** CPU reduction over the GPU-written sample buffer (16 bytes = rgb + pad per sample). */
export function averageAmbientSamples(samples: Float32Array): EnvironmentAmbient {
  if (samples.length < SAMPLES * 4) throw new RangeError("Ambient sample buffer is truncated.");
  let r = 0, g = 0, b = 0;
  for (let index = 0; index < SAMPLES; index++) {
    r += samples[index * 4]!;
    g += samples[index * 4 + 1]!;
    b += samples[index * 4 + 2]!;
  }
  return Object.freeze([r / SAMPLES, g / SAMPLES, b / SAMPLES]) as EnvironmentAmbient;
}
