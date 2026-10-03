import type { ProbeCaptureBeginContext } from "../lighting/probeClipmapCaptureExecutor.js";
import type { DeviceSession } from "./deviceSession.js";
import { PROBE_RADIANCE_MOMENT_LANES } from "../rayTracing/probeRadianceKernel.js";
import type { ProbeVolume } from "./webgpuProbeCapturePool.js";
import type { ProbeVolumeSize } from "./webgpuProbeCaptureTypes.js";

/**
 * F5 方案 A：moments 体积每逻辑探针层展开为 `PROBE_RADIANCE_MOMENT_LANES`(4) 个 lane
 * —— lane0 = (mean, variance, missRatio, valid)，lane1..3 = RGB L1 SH 方向可见度
 * （96B record words[12..23] 同合同，channel-major）。体积/预算随 lane 自动放大，
 * 绑定槽零新增；旧 1-lane 体积对新消费侧判据 `realMoments=false` → 整体安全降级。
 */
export function probeMomentsVolumeSize(radiance: ProbeVolumeSize): ProbeVolumeSize {
  const layers = radiance.layers * PROBE_RADIANCE_MOMENT_LANES;
  return { key: `${radiance.width}x${radiance.height}x${layers}/moments`,
    width: radiance.width, height: radiance.height, layers, mipCount: 1,
    bytes: radiance.width * radiance.height * layers * 16 };
}

/** Visibility output is committed beside irradiance, never read from the mutable record scratch. */
export const PROBE_MOMENTS_WGSL = /* wgsl */ `
struct ProbeUpdate { level: u32, x: u32, y: u32, z: u32 }
struct ProbeRecord {
  irradianceValidity: vec4f, visibility: vec4f, relocation: vec4f,
  reserved0: vec4f, reserved1: vec4f, reserved2: vec4f,
}
@group(0) @binding(0) var<storage, read> updates: array<ProbeUpdate>;
@group(0) @binding(1) var<storage, read_write> records: array<ProbeRecord>;
@group(0) @binding(2) var rawMoments: texture_2d_array<f32>;
@group(0) @binding(3) var radiance: texture_2d_array<f32>;
@group(0) @binding(4) var outputMoments: texture_storage_2d_array<rgba32float, write>;
// shape: x = 逻辑层每级格深(gridZ)、y = update 数、z = lane 数(= 捕获核 lane 合同)、w = 0。
@group(0) @binding(5) var<uniform> shape: vec4u;
@group(1) @binding(0) var clearedMoments: texture_storage_2d_array<rgba32float, write>;
@compute @workgroup_size(8, 8, 1)
fn clearMoments(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(clearedMoments);
  if (id.x >= size.x || id.y >= size.y || id.z >= textureNumLayers(clearedMoments)) { return; }
  textureStore(clearedMoments, vec2i(id.xy), i32(id.z), vec4f(0.0, 0.0, 0.0, -1.0));
}
@compute @workgroup_size(64)
fn publishMoments(@builtin(global_invocation_id) id: vec3u) {
  let count = min(shape.y, arrayLength(&updates));
  if (id.x >= count) { return; }
  let update = updates[id.x]; let size = textureDimensions(outputMoments);
  let logicalLayer = update.z + (update.level & 0x7fffffffu) * shape.x;
  let logicalLayers = textureNumLayers(outputMoments) / shape.z;
  if (update.x >= size.x || update.y >= size.y || logicalLayer >= logicalLayers) { return; }
  let recordIndex = (logicalLayer * size.y + update.y) * size.x + update.x;
  if (recordIndex >= arrayLength(&records)) { return; }
  let cell = vec2i(i32(update.x), i32(update.y));
  let moment = textureLoad(rawMoments, cell, i32(logicalLayer * shape.z + 0u), 0);
  let rgb = textureLoad(radiance, cell, i32(logicalLayer), 0);
  records[recordIndex].irradianceValidity = vec4f(rgb.rgb, select(0.0, rgb.a, moment.w > 0.0));
  records[recordIndex].visibility = vec4f(moment.xyz, 0.0);
  // F5 方案 A：words[12..23] = RGB L1 SH（raw lane1..3，channel-major l0/m-1/m0/m1）。
  // 无效/缺失捕获写全零 = SH 缺失，消费侧按标量门 fallback；relocation lane 归既有
  // owner，不覆盖。
  if (moment.w > 0.0) {
    records[recordIndex].reserved0 = textureLoad(rawMoments, cell, i32(logicalLayer * shape.z + 1u), 0);
    records[recordIndex].reserved1 = textureLoad(rawMoments, cell, i32(logicalLayer * shape.z + 2u), 0);
    records[recordIndex].reserved2 = textureLoad(rawMoments, cell, i32(logicalLayer * shape.z + 3u), 0);
  } else {
    records[recordIndex].reserved0 = vec4f(0.0);
    records[recordIndex].reserved1 = vec4f(0.0);
    records[recordIndex].reserved2 = vec4f(0.0);
  }
  for (var lane = 0u; lane < shape.z; lane = lane + 1u) {
    let value = select(vec4f(0.0), textureLoad(rawMoments, cell, i32(logicalLayer * shape.z + lane), 0),
      lane == 0u || moment.w > 0.0);
    textureStore(outputMoments, cell, i32(logicalLayer * shape.z + lane), value);
  }
}`;

export class WebGpuProbeMomentsPipeline {
  private readonly clearLayout: GPUBindGroupLayout;
  private readonly publishLayout: GPUBindGroupLayout;
  private readonly clearPipeline: GPUComputePipeline;
  private readonly publishPipeline: GPUComputePipeline;

  constructor(private readonly session: DeviceSession) {
    const device = session.device;
    const module = device.createShaderModule({ label: "Deep GI real visibility publication", code: PROBE_MOMENTS_WGSL });
    const empty = device.createBindGroupLayout({ entries: [] });
    this.clearLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE,
      storageTexture: { access: "write-only", format: "rgba32float", viewDimension: "2d-array" } }] });
    this.clearPipeline = device.createComputePipeline({ label: "Deep GI clear moments",
      layout: device.createPipelineLayout({ bindGroupLayouts: [empty, this.clearLayout] }),
      compute: { module, entryPoint: "clearMoments" } });
    this.publishLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float", viewDimension: "2d-array" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float", viewDimension: "2d-array" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: "write-only", format: "rgba32float", viewDimension: "2d-array" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
    ] });
    this.publishPipeline = device.createComputePipeline({ label: "Deep GI publish moments",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.publishLayout] }),
      compute: { module, entryPoint: "publishMoments" } });
  }

  clear(encoder: GPUCommandEncoder, volume: ProbeVolume): void {
    const binding = this.session.device.createBindGroup({ layout: this.clearLayout,
      entries: [{ binding: 0, resource: volume.view }] });
    const pass = encoder.beginComputePass({ label: "Deep GI clear moments" });
    pass.setPipeline(this.clearPipeline); pass.setBindGroup(1, binding);
    pass.dispatchWorkgroups(Math.ceil(volume.width / 8), Math.ceil(volume.height / 8), volume.layers); pass.end();
  }

  publish(encoder: GPUCommandEncoder, context: ProbeCaptureBeginContext, updates: GPUBuffer, uniform: GPUBuffer,
    raw: ProbeVolume, output: ProbeVolume, radiance: ProbeVolume): void {
    const binding = this.session.device.createBindGroup({ layout: this.publishLayout, entries: [
      { binding: 0, resource: { buffer: updates } },
      { binding: 1, resource: { buffer: context.resource.probeStorageBuffer } },
      { binding: 2, resource: raw.view }, { binding: 3, resource: radiance.levels[0]! },
      { binding: 4, resource: output.view },
      { binding: 5, resource: { buffer: uniform } },
    ] });
    const pass = encoder.beginComputePass({ label: "Deep GI publish moments" });
    pass.setPipeline(this.publishPipeline); pass.setBindGroup(0, binding);
    pass.dispatchWorkgroups(Math.ceil(context.plan.updates.length / 64)); pass.end();
  }
}
