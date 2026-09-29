import type { VirtualTextureCatalogEntry, VirtualTextureSampleRequest } from "./virtualTextureFrameBridge.js";
import type { VirtualTexturePage } from "../virtualTextures/virtualTexturePages.js";

/**
 * T06 虚拟纹理页→GPU 布局打包与页表打包缓存(CPU 页表更新路径)。
 *
 * 现状(前路径):采样消费每帧全量重打包页表——packVirtualTexturePageTable 遍历
 * 目录全部纹理 × 全 mip × 全 tile 并全量重写 meta/layers 大缓冲,稳定帧(页表与
 * 目录均无变化)是纯重复劳动。VirtualTexturePageTablePacker 以
 * (catalogEpoch, layerEpoch) 双版本号为键缓存打包结果:两个 epoch 都不变 ⇒
 * packing 逐字节不变,直接复用(O(1));任一变化(纹理目录增删换版 / 层分配
 * commit-逐出-回滚)才重打包并递增打包版本。
 *
 * epoch 合同:同一 epoch 的 packing 保证逐字节相同;消费方(virtualTextureSampling
 * 的 encode)据此跳过大缓冲重写。params[0](样本数)不进缓存键——由消费方每帧覆盖,
 * 缓存内的 params[0] 恒为 0。GPU 真机帧时未测(零 readback 口径),CPU 打包耗时
 * 前后对照由 bench 量化(test-output 证据 JSON)。
 */

/** 页表 GPU 装载三元组:params 常量段 + 每 (texture, mip) 元数据行 + 页→layer 段。 */
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

/** 打包产物 + 版本号;epoch 不变 ⇒ data 逐字节不变(消费方跳过重写的依据)。 */
export interface VirtualTexturePackedPageTable {
  readonly epoch: number;
  readonly data: VirtualTexturePageTablePacking;
}

export class VirtualTexturePageTablePacker {
  private readonly catalog: () => readonly VirtualTextureCatalogEntry[];
  private readonly layerOfPage: (textureId: string, tileX: number, tileY: number,
    mip: number) => number | undefined;
  private readonly atlasEdge: number;
  private cached: { readonly catalogEpoch: number; readonly layerEpoch: number;
    readonly packed: VirtualTexturePackedPageTable } | undefined;
  private nextEpoch = 0;
  private repackCountValue = 0;

  constructor(catalog: () => readonly VirtualTextureCatalogEntry[],
    layerOfPage: (textureId: string, tileX: number, tileY: number, mip: number) => number | undefined,
    atlasEdge: number) {
    if (typeof catalog !== "function" || typeof layerOfPage !== "function") {
      throw new TypeError("Virtual texture page table packer expects provider functions.");
    }
    if (!Number.isSafeInteger(atlasEdge) || atlasEdge < 1) {
      throw new RangeError("Virtual texture page table packer atlasEdge must be a positive safe integer.");
    }
    this.catalog = catalog;
    this.layerOfPage = layerOfPage;
    this.atlasEdge = atlasEdge;
  }

  /** 打包版本号(单调递增,0 = 尚未打包)。 */
  get epoch(): number { return this.cached?.packed.epoch ?? -1; }
  /** 自构造以来实际重打包次数(缓存命中不计数;遥测/对照口径)。 */
  get repackCount(): number { return this.repackCountValue; }

  /**
   * 取打包产物:(catalogEpoch, layerEpoch) 均与缓存一致时 O(1) 复用,否则重打包。
   * layerOfPage 只在重打包时调用——消费方可传 spy 断言稳定帧零调用。
   */
  pack(catalogEpoch: number, layerEpoch: number): VirtualTexturePackedPageTable {
    if (!Number.isSafeInteger(catalogEpoch) || catalogEpoch < 0
      || !Number.isSafeInteger(layerEpoch) || layerEpoch < 0) {
      throw new RangeError("Virtual texture packer epochs must be non-negative safe integers.");
    }
    const cached = this.cached;
    if (cached && cached.catalogEpoch === catalogEpoch && cached.layerEpoch === layerEpoch) {
      return cached.packed;
    }
    // params[0](样本数)由消费方每帧覆盖;缓存恒以空样本集打包,占位 0。
    const data = packVirtualTexturePageTable(this.catalog(), this.layerOfPage, [], this.atlasEdge);
    const packed: VirtualTexturePackedPageTable = Object.freeze(
      { epoch: this.nextEpoch++, data });
    this.cached = { catalogEpoch, layerEpoch, packed };
    this.repackCountValue += 1;
    return packed;
  }
}

/** 页字节按生边 edge²(零填充)紧排;writeTexture 行距须 256 对齐,生边 < 64 时
 *  行距上取整并逐行重排进临时缓冲(仅深 mip 小页,单页 ≤ 16 KiB)。 */
export function uploadLayout(page: VirtualTexturePage, tileEdgeTexels: number): {
  readonly data: Uint8Array<ArrayBuffer>; readonly bytesPerRow: number; readonly edge: number;
} {
  const edge = Math.max(1, tileEdgeTexels >> page.mip);
  const rawRow = edge * 4;
  const bytesPerRow = Math.ceil(rawRow / 256) * 256;
  if (bytesPerRow === rawRow) return { data: page.data, bytesPerRow, edge };
  const padded = new Uint8Array(bytesPerRow * (edge - 1) + rawRow);
  for (let row = 0; row < edge; row++) {
    padded.set(page.data.subarray(row * rawRow, (row + 1) * rawRow), row * bytesPerRow);
  }
  return { data: padded, bytesPerRow, edge };
}

/** 消费方每帧覆盖样本数的 params 覆本(不污染缓存内的共享数组)。 */
export function packedPageTableParamsWithSamples(packing: VirtualTexturePageTablePacking,
  samples: readonly VirtualTextureSampleRequest[]): Uint32Array<ArrayBuffer> {
  const params = packing.params.slice();
  params[0] = samples.length;
  return params;
}
