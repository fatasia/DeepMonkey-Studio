// F3/T06 虚拟纹理 probe 读回 harness(sourceSizeGate 拆分:自 f3VirtualTextureGpuProbe.ts
// 按职责分文件,代码逐行同源,仅改可见性;语义零变化)。
// 职责:生产 tile-lookup WGSL 读回 + 全量纹理基线读回(同一份生产 WGSL/打包页表/atlas
// 视图/样本布局,自持缓冲,不修改任何生产语义)。
import { DeviceSession } from "../src/webgpu/deviceSession.js";
import { VIRTUAL_TEXTURE_TILE_LOOKUP_WGSL } from "../src/webgpu/virtualTextureSampling.js";
import { packedPageTableParamsWithSamples, type VirtualTexturePageTablePacking } from "../src/webgpu/virtualTexturePagePacking.js";
import type { VirtualTextureCatalogEntry, VirtualTextureSampleRequest } from "../src/webgpu/virtualTextureFrameBridge.js";
import type { DecodedTexture } from "../src/textures/decodedTexture.js";

export function packSamplesFloat32(samples: readonly VirtualTextureSampleRequest[]): Float32Array<ArrayBuffer> {
  const packed = new Float32Array(samples.length * 4);
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]!;
    packed[index * 4] = sample.u; packed[index * 4 + 1] = sample.v;
    packed[index * 4 + 2] = sample.textureIndex; packed[index * 4 + 3] = sample.mip;
  }
  return packed;
}

const READBACK_TILE_LOOKUP_LAYOUT: GPUBindGroupLayoutDescriptor = {
  label: "F3 VT readback tile lookup layout(生产 7 绑定面拷贝,仅联测读回)",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float", viewDimension: "2d-array" } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
    { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
  ],
};

const REFERENCE_WGSL = /* wgsl */ `
// 全量纹理基线(等价口径):同一 RGBA8 数据建整纹理,线性 clamp 采样,与 tile-lookup 同 UV/mip。
struct RefParams { sampleCount : u32, pad0 : u32, pad1 : u32, pad2 : u32 };
@group(0) @binding(0) var<storage, read> params : RefParams;
@group(0) @binding(1) var reference : texture_2d<f32>;
@group(0) @binding(2) var referenceSampler : sampler;
@group(0) @binding(3) var<storage, read> samples : array<vec4f>;
@group(0) @binding(4) var<storage, read_write> outColors : array<vec4f>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid : vec3u) {
  if (gid.x >= params.sampleCount) { return; }
  let sample = samples[gid.x];
  outColors[gid.x] = textureSampleLevel(reference, referenceSampler, sample.xy, f32(sample.w));
}
`;

const REFERENCE_LAYOUT: GPUBindGroupLayoutDescriptor = {
  label: "F3 VT reference layout",
  entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
  ],
};

interface ReadbackTargets {
  readonly samplesBuffer: GPUBuffer; readonly outBuffer: GPUBuffer; readonly staging: GPUBuffer;
}

function createReadbackTargets(device: GPUDevice, sampleCount: number): ReadbackTargets {
  // out 需要 COPY_SRC(copyBufferToBuffer 源)+ STORAGE(compute 写入)+ COPY_DST(冗余无害)。
  const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
  return {
    samplesBuffer: device.createBuffer({ label: "F3 VT readback samples", size: sampleCount * 16, usage: storage }),
    outBuffer: device.createBuffer({ label: "F3 VT readback out", size: sampleCount * 16, usage: storage }),
    staging: device.createBuffer({ label: "F3 VT readback staging",
      size: sampleCount * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
  };
}

function destroyTargets(targets: ReadbackTargets): void {
  targets.samplesBuffer.destroy(); targets.outBuffer.destroy(); targets.staging.destroy();
}

async function readBackTargets(device: GPUDevice, targets: ReadbackTargets,
  sampleCount: number): Promise<Float32Array> {
  const encoder = device.createCommandEncoder({ label: "F3 VT readback copy" });
  encoder.copyBufferToBuffer(targets.outBuffer, 0, targets.staging, 0, sampleCount * 16);
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await targets.staging.mapAsync(GPUMapMode.READ);
  return new Float32Array(targets.staging.getMappedRange().slice(0));
}

export interface CaptureInputs {
  readonly catalog: readonly VirtualTextureCatalogEntry[];
  readonly layerOfPage: (textureId: string, tileX: number, tileY: number, mip: number) => number | undefined;
  /** bridge.packPageTable().data(生产打包缓存产物);证据腿不处于 fallback。 */
  readonly packing: VirtualTexturePageTablePacking;
  readonly atlasEdge: number;
  readonly atlasView: GPUTextureView;
}

/** 生产 tile-lookup WGSL 读回:同 shader 源 + bridge 打包页表 + atlas 视图 + 同样本布局。 */
export async function captureViaTileLookup(session: DeviceSession, inputs: CaptureInputs,
  samples: readonly VirtualTextureSampleRequest[]): Promise<Float32Array> {
  const device = session.device;
  const packing = inputs.packing;
  const params = packedPageTableParamsWithSamples(packing, samples);
  const targets = createReadbackTargets(device, samples.length);
  const metaBuffer = device.createBuffer({ label: "F3 VT readback meta",
    size: Math.max(16, packing.mipMeta.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const layersBuffer = device.createBuffer({ label: "F3 VT readback layers",
    size: Math.max(16, packing.pageLayers.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const paramsBuffer = device.createBuffer({ label: "F3 VT readback params",
    size: Math.max(16, params.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  try {
    device.queue.writeBuffer(paramsBuffer, 0, params);
    device.queue.writeBuffer(metaBuffer, 0, packing.mipMeta);
    device.queue.writeBuffer(layersBuffer, 0, packing.pageLayers);
    device.queue.writeBuffer(targets.samplesBuffer, 0, packSamplesFloat32(samples));
    const module = device.createShaderModule({ label: "F3 VT readback tile lookup(生产 WGSL 单源)",
      code: VIRTUAL_TEXTURE_TILE_LOOKUP_WGSL });
    const layout = device.createBindGroupLayout(READBACK_TILE_LOOKUP_LAYOUT);
    const pipeline = device.createComputePipeline({ label: "F3 VT readback tile lookup",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module, entryPoint: "main" } });
    const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear",
      addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    const bindGroup = device.createBindGroup({ layout, entries: [
      { binding: 0, resource: { buffer: paramsBuffer } },
      { binding: 1, resource: { buffer: metaBuffer } },
      { binding: 2, resource: { buffer: layersBuffer } },
      { binding: 3, resource: inputs.atlasView },
      { binding: 4, resource: sampler },
      { binding: 5, resource: { buffer: targets.samplesBuffer } },
      { binding: 6, resource: { buffer: targets.outBuffer } },
    ] });
    const encoder = device.createCommandEncoder({ label: "F3 VT readback tile lookup" });
    const pass = encoder.beginComputePass({ label: "F3 VT readback tile lookup pass" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(samples.length / 64));
    pass.end();
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    return await readBackTargets(device, targets, samples.length);
  } finally {
    metaBuffer.destroy(); layersBuffer.destroy(); paramsBuffer.destroy();
    destroyTargets(targets);
  }
}

// ────────────────────────── 全量纹理基线 ──────────────────────────
export async function captureViaReference(session: DeviceSession, texture: DecodedTexture,
  samples: readonly VirtualTextureSampleRequest[]): Promise<Float32Array> {
  const device = session.device;
  const gpuTexture = device.createTexture({ label: "F3 VT reference whole texture",
    size: { width: texture.width, height: texture.height, depthOrArrayLayers: 1 },
    format: "rgba8unorm", dimension: "2d", mipLevelCount: 1,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  try {
    device.queue.writeTexture({ texture: gpuTexture }, texture.data,
      { bytesPerRow: texture.width * 4, rowsPerImage: texture.height },
      { width: texture.width, height: texture.height, depthOrArrayLayers: 1 });
    const params = new Uint32Array([samples.length, 0, 0, 0]);
    const targets = createReadbackTargets(device, samples.length);
    const paramsBuffer = device.createBuffer({ label: "F3 VT reference params",
      size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    try {
      device.queue.writeBuffer(paramsBuffer, 0, params);
      device.queue.writeBuffer(targets.samplesBuffer, 0, packSamplesFloat32(samples));
      const module = device.createShaderModule({ label: "F3 VT reference WGSL", code: REFERENCE_WGSL });
      const layout = device.createBindGroupLayout(REFERENCE_LAYOUT);
      const pipeline = device.createComputePipeline({ label: "F3 VT reference pipeline",
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint: "main" } });
      const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear",
        addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
      const bindGroup = device.createBindGroup({ layout, entries: [
        { binding: 0, resource: { buffer: paramsBuffer } },
        { binding: 1, resource: gpuTexture.createView() },
        { binding: 2, resource: sampler },
        { binding: 3, resource: { buffer: targets.samplesBuffer } },
        { binding: 4, resource: { buffer: targets.outBuffer } },
      ] });
      const encoder = device.createCommandEncoder({ label: "F3 VT reference capture" });
      const pass = encoder.beginComputePass({ label: "F3 VT reference pass" });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(samples.length / 64));
      pass.end();
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
      return await readBackTargets(device, targets, samples.length);
    } finally {
      paramsBuffer.destroy();
      destroyTargets(targets);
    }
  } finally { gpuTexture.destroy(); }
}

export function fullImageSamples(width: number, height: number): VirtualTextureSampleRequest[] {
  const samples: VirtualTextureSampleRequest[] = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      samples.push({ textureIndex: 0, u: (x + 0.5) / width, v: (y + 0.5) / height, mip: 0 });
  return samples;
}
