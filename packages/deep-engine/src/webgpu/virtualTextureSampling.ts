import type { DeviceSession } from "./deviceSession.js";
import type { VirtualTextureCatalogEntry, VirtualTextureSampleRequest } from "./virtualTextureFrameBridge.js";

/**
 * F4 虚拟纹理采样消费:独立绑定组 tile-lookup compute pass。
 *
 * pbrShader 主 pass 接入属后续 lane(C9 在途域禁碰);本 pass 以**真实 tile lookup
 * 形态**保持消费链活跃:GPU 侧按 页表 storage → atlas array 采样,与未来材质路径
 * 同构——页表布局、缺页哨兵、mip 网格推导是同一份合同,迁移时只换绑定组归属。
 * opt-in(virtualTextures.enabled)才构造;缺页样本输出 magenta 哨兵色(fail-closed
 * 可见,不伪造采样)。输出仅驻留 GPU(产品帧零 readback),像素对照由联测脚本显式读回。
 */

export const VIRTUAL_TEXTURE_TILE_LOOKUP_WGSL = /* wgsl */ `
struct VtParams {
  sampleCount : u32,
  textureCount : u32,
  maxChainMips : u32,
  atlasEdge : u32,
};
@group(0) @binding(0) var<storage, read> params : VtParams;
// 每 (texture, mip) 一行:gridW, gridH, pageLayerOffset(i32 元素), mipEdge。
@group(0) @binding(1) var<storage, read> mipMeta : array<vec4u>;
// 页 → atlas layer;-1 = 缺页(输出哨兵色)。
@group(0) @binding(2) var<storage, read> pageLayers : array<i32>;
@group(0) @binding(3) var atlas : texture_2d_array<f32>;
@group(0) @binding(4) var atlasSampler : sampler;
@group(0) @binding(5) var<storage, read> samples : array<vec4f>;
@group(0) @binding(6) var<storage, read_write> outColors : array<vec4f>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid : vec3u) {
  if (gid.x >= params.sampleCount) { return; }
  let sample = samples[gid.x];
  let texIndex = min(u32(sample.z), params.textureCount - 1u);
  let lod = min(u32(sample.w), params.maxChainMips - 1u);
  let meta = mipMeta[texIndex * params.maxChainMips + lod];
  let grid = vec2u(meta.xy);
  if (grid.x == 0u || grid.y == 0u) { outColors[gid.x] = vec4f(1.0, 0.0, 1.0, 1.0); return; }
  let tile = min(vec2u(sample.xy * vec2f(grid)), grid - 1u);
  let layer = pageLayers[meta.z + tile.y * grid.x + tile.x];
  // 页内相对坐标 × (mipEdge / atlasEdge):atlas 每 layer 恰一张 mip0 边长页。
  let pageUv = (vec2f(tile) + clamp(fract(sample.xy) * vec2f(grid) - vec2f(tile), vec2f(0.0), vec2f(1.0)))
    * (f32(meta.w) / f32(params.atlasEdge));
  let color = select(vec4f(1.0, 0.0, 1.0, 1.0),
    textureSampleLevel(atlas, atlasSampler, pageUv, u32(layer), 0.0), layer >= 0);
  outColors[gid.x] = color;
}
`;

export interface VirtualTexturePageTablePacking {
  readonly params: Uint32Array<ArrayBuffer>;
  readonly mipMeta: Uint32Array<ArrayBuffer>;
  readonly pageLayers: Int32Array<ArrayBuffer>;
}

/** 页表 CPU 打包:每 (texture, mip) 元数据行 + 连续页 layer 段;-1 表缺页。
 *  atlasEdge = 页 atlas 的 layer 边长(= spec.tileEdgeTexels),mipEdge = atlasEdge >> mip。 */
export function packVirtualTexturePageTable(catalog: readonly VirtualTextureCatalogEntry[],
  layerOfPage: (textureId: string, tileX: number, tileY: number, mip: number) => number | undefined,
  samples: readonly VirtualTextureSampleRequest[], atlasEdge: number): VirtualTexturePageTablePacking {
  const maxChainMips = Math.max(1, ...catalog.map(entry => entry.chainMips));
  const metaRows = catalog.length * maxChainMips;
  let layerCount = 0;
  for (const entry of catalog) for (const grid of entry.mipGrids) layerCount += grid.gridWidth * grid.gridHeight;
  const mipMeta = new Uint32Array(metaRows * 4);
  const pageLayers = new Int32Array(Math.max(1, layerCount)).fill(-1);
  let cursor = 0;
  for (let index = 0; index < catalog.length; index++) {
    const entry = catalog[index]!;
    for (let mip = 0; mip < maxChainMips; mip++) {
      const grid = entry.mipGrids[Math.min(mip, entry.mipGrids.length - 1)];
      const row = (index * maxChainMips + mip) * 4;
      if (!grid) continue;
      mipMeta[row] = grid.gridWidth; mipMeta[row + 1] = grid.gridHeight;
      mipMeta[row + 2] = cursor;
      mipMeta[row + 3] = Math.max(1, atlasEdge >> mip);
      for (let tileY = 0; tileY < grid.gridHeight; tileY++) {
        for (let tileX = 0; tileX < grid.gridWidth; tileX++) {
          const layer = layerOfPage(entry.textureId, tileX, tileY, mip);
          pageLayers[cursor + tileY * grid.gridWidth + tileX] = layer ?? -1;
        }
      }
      cursor += grid.gridWidth * grid.gridHeight;
    }
  }
  const params = new Uint32Array([samples.length, catalog.length, maxChainMips, Math.max(1, atlasEdge)]);
  return { params, mipMeta, pageLayers };
}

export interface VirtualTileLookupFrameInput {
  readonly atlasView: GPUTextureView;
  /** atlas layer 边长(= spec.tileEdgeTexels);页内 uv 归一化基准。 */
  readonly atlasEdge: number;
  readonly catalog: readonly VirtualTextureCatalogEntry[];
  readonly layerOfPage: (textureId: string, tileX: number, tileY: number, mip: number) => number | undefined;
  readonly samples: readonly VirtualTextureSampleRequest[];
}

export interface VirtualTileLookupFrameResult {
  readonly dispatches: number;
  readonly samples: number;
  readonly skipped: "no-samples" | "no-atlas-view" | "over-capacity" | undefined;
}

const MAX_CATALOG_TEXTURES = 64;
const MAX_PAGE_LAYER_ENTRIES = 1 << 22;
const MAX_SAMPLES_PER_FRAME = 64;
const WORKGROUP_SIZE = 64;

/** tile-lookup 消费 pass:opt-in 专属,缓冲按目录/样本规模懒建,变化帧全量重写。 */
export class VirtualTextureTileLookupPass {
  private readonly device: GPUDevice;
  private pipeline: GPUComputePipeline | undefined;
  private layout: GPUBindGroupLayout | undefined;
  private sampler: GPUSampler | undefined;
  private paramsBuffer: GPUBuffer | undefined;
  private metaBuffer: GPUBuffer | undefined;
  private layersBuffer: GPUBuffer | undefined;
  private samplesBuffer: GPUBuffer | undefined;
  private outBuffer: GPUBuffer | undefined;
  private atlasViews = new WeakMap<GPUTexture, GPUTextureView>();
  private disposed = false;

  constructor(session: DeviceSession) {
    this.device = session.device;
  }

  /** 编码本帧采样消费;目录超容量/无样本/无 atlas 视图显式跳过(不静默,原因随遥测披露)。 */
  encode(encoder: GPUCommandEncoder, input: VirtualTileLookupFrameInput): VirtualTileLookupFrameResult {
    if (this.disposed) throw new Error("Virtual texture tile lookup pass is disposed.");
    if (input.samples.length === 0) return { dispatches: 0, samples: 0, skipped: "no-samples" };
    if (input.catalog.length === 0 || input.catalog.length > MAX_CATALOG_TEXTURES
      || input.samples.length > MAX_SAMPLES_PER_FRAME) {
      return { dispatches: 0, samples: 0, skipped: "over-capacity" };
    }
    const packing = packVirtualTexturePageTable(input.catalog, input.layerOfPage, input.samples, input.atlasEdge);
    if (packing.pageLayers.length > MAX_PAGE_LAYER_ENTRIES) {
      return { dispatches: 0, samples: 0, skipped: "over-capacity" };
    }
    if (!this.paramsBuffer || this.paramsBuffer.size < packing.params.byteLength
      || this.layersBuffer!.size < packing.pageLayers.byteLength
      || this.metaBuffer!.size < packing.mipMeta.byteLength) {
      this.ensureBuffers(packing);
    }
    this.device.queue.writeBuffer(this.paramsBuffer!, 0, packing.params);
    this.device.queue.writeBuffer(this.metaBuffer!, 0, packing.mipMeta);
    this.device.queue.writeBuffer(this.layersBuffer!, 0, packing.pageLayers);
    this.device.queue.writeBuffer(this.samplesBuffer!, 0, packSamples(input.samples));
    const pass = encoder.beginComputePass({ label: "Deep virtual texture tile lookup" });
    pass.setPipeline(this.ensurePipeline());
    pass.setBindGroup(0, this.device.createBindGroup({ layout: this.layout!, entries: [
      { binding: 0, resource: { buffer: this.paramsBuffer! } },
      { binding: 1, resource: { buffer: this.metaBuffer! } },
      { binding: 2, resource: { buffer: this.layersBuffer! } },
      { binding: 3, resource: input.atlasView },
      { binding: 4, resource: this.ensureSampler() },
      { binding: 5, resource: { buffer: this.samplesBuffer! } },
      { binding: 6, resource: { buffer: this.outBuffer! } },
    ] }));
    pass.dispatchWorkgroups(Math.ceil(input.samples.length / WORKGROUP_SIZE));
    pass.end();
    return { dispatches: 1, samples: input.samples.length, skipped: undefined };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const buffer of [this.paramsBuffer, this.metaBuffer, this.layersBuffer, this.samplesBuffer, this.outBuffer]) {
      buffer?.destroy();
    }
    this.paramsBuffer = this.metaBuffer = this.layersBuffer = this.samplesBuffer = this.outBuffer = undefined;
    this.pipeline = undefined; this.layout = undefined; this.sampler = undefined;
    this.atlasViews = new WeakMap();
  }

  /** atlas 的 2d-array 视图(按纹理缓存;residency 内建 view 是单层 2d 形态,不复用)。 */
  viewOf(atlas: GPUTexture): GPUTextureView {
    const cached = this.atlasViews.get(atlas);
    if (cached) return cached;
    const view = atlas.createView({ dimension: "2d-array" });
    this.atlasViews.set(atlas, view);
    return view;
  }

  private ensureSampler(): GPUSampler {
    this.sampler ??= this.device.createSampler({ label: "Deep virtual texture tile sampler",
      magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    return this.sampler;
  }

  private ensureBuffers(packing: VirtualTexturePageTablePacking): void {
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const alloc = (bytes: number, label: string): GPUBuffer =>
      this.device.createBuffer({ label, size: Math.max(16, bytes), usage });
    this.paramsBuffer?.destroy();
    this.metaBuffer?.destroy();
    this.layersBuffer?.destroy();
    this.paramsBuffer = alloc(packing.params.byteLength, "Deep virtual texture params");
    this.metaBuffer = alloc(packing.mipMeta.byteLength, "Deep virtual texture mip meta");
    this.layersBuffer = alloc(packing.pageLayers.byteLength, "Deep virtual texture page layers");
    if (!this.samplesBuffer) this.samplesBuffer = alloc(MAX_SAMPLES_PER_FRAME * 16, "Deep virtual texture samples");
    if (!this.outBuffer) this.outBuffer = alloc(MAX_SAMPLES_PER_FRAME * 16, "Deep virtual texture sample colors");
  }

  private ensurePipeline(): GPUComputePipeline {
    if (this.pipeline) return this.pipeline;
    const module = this.device.createShaderModule({ label: "Deep virtual texture tile lookup WGSL",
      code: VIRTUAL_TEXTURE_TILE_LOOKUP_WGSL });
    this.layout = this.device.createBindGroupLayout({ label: "Deep virtual texture tile lookup layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float", viewDimension: "2d-array" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ] });
    this.pipeline = this.device.createComputePipeline({ label: "Deep virtual texture tile lookup",
      layout: this.device.createPipelineLayout({ label: "Deep virtual texture tile lookup pipeline layout",
        bindGroupLayouts: [this.layout] }),
      compute: { module, entryPoint: "main" } });
    return this.pipeline;
  }
}

function packSamples(samples: readonly VirtualTextureSampleRequest[]): Float32Array<ArrayBuffer> {
  const packed = new Float32Array(samples.length * 4);
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]!;
    packed[index * 4] = sample.u; packed[index * 4 + 1] = sample.v;
    packed[index * 4 + 2] = sample.textureIndex; packed[index * 4 + 3] = sample.mip;
  }
  return packed;
}
