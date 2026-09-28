import type { DecodedTexture, PixelLevel, PreparedTexture } from "../textures/decodedTexture.js";
import { planTextureMips, prepareTextures } from "../textures/decodedTexture.js";

/**
 * T06 offline virtual-texture page generation (CPU, deterministic).
 *
 * A page is one (texture, tileX, tileY, mip): the full mip chain is built once
 * on the whole image, then every level is cut into fixed tileEdge×tileEdge
 * RGBA8 tiles. Edge tiles are zero-padded to the full tile size so page cost
 * is a constant `tileEdge²·bytesPerTexel` upper bound at every mip; samplers
 * must clamp to the page's valid width/height. The prototype is NOT wired into
 * the default renderer; existing whole-texture residency stays authoritative.
 *
 * 不替换默认路径：消费方仍走 GpuTextureResidencyUploader 的整纹理 LOD 驻留；
 * 本模块只产出确定性页数据与页表，供策略验证与后续 GPU 联调。
 */

export interface VirtualTextureTileSpec {
  /** Tile edge in texels per mip level; must be a power of two ≥ 1. */
  readonly tileEdgeTexels: number;
  readonly bytesPerTexel: number;
}

export const DEFAULT_VIRTUAL_TEXTURE_TILE: VirtualTextureTileSpec =
  Object.freeze({ tileEdgeTexels: 128, bytesPerTexel: 4 });

export interface VirtualTexturePage {
  readonly id: string;
  readonly textureId: string;
  readonly tileX: number;
  readonly tileY: number;
  /** Detail level of this fixed mip-0 region: edge = tileEdgeTexels >> mip. */
  readonly mip: number;
  /** Valid texels inside the page; ragged edges pad the remainder with zeros. */
  readonly width: number;
  readonly height: number;
  readonly costBytes: number;
  readonly data: Uint8Array<ArrayBuffer>;
}

export interface VirtualTexturePageTableData {
  readonly textureId: string;
  readonly spec: VirtualTextureTileSpec;
  readonly mipCount: number;
  readonly gridX: number;
  readonly gridY: number;
  /** Chain length per tile: mips 0..chainMips-1, ending at a 1x1 region page. */
  readonly chainMips: number;
  readonly pages: readonly VirtualTexturePage[];
  readonly pageByTile: ReadonlyMap<string, VirtualTexturePage>;
  readonly totalBytes: number;
}

export function virtualTexturePageId(textureId: string, tileX: number, tileY: number, mip: number): string {
  return `${textureId}|${tileX},${tileY}|mip${mip}`;
}

export function virtualTexturePageCostBytes(spec: VirtualTextureTileSpec, mip: number): number {
  const edge = Math.max(1, spec.tileEdgeTexels >> mip);
  return edge * edge * spec.bytesPerTexel;
}

/** Deterministic integer box downsample: 2×2 average, tail row/column half-weighted. */
export function boxDownsampleRgba8(level: PixelLevel): PixelLevel {
  const width = Math.max(1, Math.floor(level.width / 2));
  const height = Math.max(1, Math.floor(level.height / 2));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let channel = 0; channel < 4; channel++) {
        let sum = 0, count = 0;
        for (const [sy, sx] of [[y * 2, x * 2], [y * 2, x * 2 + 1], [y * 2 + 1, x * 2], [y * 2 + 1, x * 2 + 1]] as const) {
          if (sy < level.height && sx < level.width) { sum += level.data[(sy * level.width + sx) * 4 + channel]!; count += 1; }
        }
        data[(y * width + x) * 4 + channel] = (sum / count) | 0;
      }
    }
  }
  return { width, height, data };
}

/** Procedural checker-plus-gradient RGBA8 texture; same seed and size, same bytes. */
export function createSyntheticRgba8(id: string, width: number, height: number, seed: number): DecodedTexture {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const checker = ((x >> 4) + (y >> 4)) & 1;
      const offset = (y * width + x) * 4;
      data[offset] = checker ? 96 + (x * 255 / width | 0) : 24 + (x * 96 / width | 0);
      data[offset + 1] = checker ? 96 + (y * 255 / height | 0) : 24 + (y * 96 / height | 0);
      data[offset + 2] = (seed ^ (x * 7 + y * 13)) & 255;
      data[offset + 3] = 255;
    }
  }
  return { id, revision: 0, semantic: "baseColor", width, height, data };
}

/**
 * Builds the deterministic page set for one texture: decode/validate through
 * the existing prepareTextures chain, complete the mip chain by box filter,
 * then cut every level into zero-padded fixed-cost tiles.
 */
export function generateVirtualTexturePages(source: DecodedTexture,
  spec: VirtualTextureTileSpec = DEFAULT_VIRTUAL_TEXTURE_TILE): VirtualTexturePageTableData {
  validateSpec(spec);
  const plan = planTextureMips(source.width, source.height);
  const mipmaps = source.mipmaps ?? buildMipChain(source, plan.length);
  if (mipmaps.length !== plan.length - 1) {
    throw new Error(`Virtual texture ${source.id} mip chain must be complete until 1x1.`);
  }
  const prepared = prepareTextures([{ ...source, mipmaps }]);
  return paginatePreparedTexture(prepared[0]!, spec);
}

/** Cuts an already-prepared texture (complete mip chain) into region-constant pages. */
export function paginatePreparedTexture(prepared: PreparedTexture,
  spec: VirtualTextureTileSpec = DEFAULT_VIRTUAL_TEXTURE_TILE): VirtualTexturePageTableData {
  validateSpec(spec);
  const chainMips = Math.min(prepared.levels.length,
    Math.round(1 + Math.log2(spec.tileEdgeTexels)));
  const gridX = Math.ceil(prepared.levels[0]!.width / spec.tileEdgeTexels);
  const gridY = Math.ceil(prepared.levels[0]!.height / spec.tileEdgeTexels);
  const pages: VirtualTexturePage[] = [];
  const pageByTile = new Map<string, VirtualTexturePage>();
  let totalBytes = 0;
  for (let tileY = 0; tileY < gridY; tileY++) {
    for (let tileX = 0; tileX < gridX; tileX++) {
      for (let mip = 0; mip < chainMips; mip++) {
        const edge = Math.max(1, spec.tileEdgeTexels >> mip);
        const level = prepared.levels[Math.min(mip, prepared.levels.length - 1)]!;
        const x0 = tileX * edge, y0 = tileY * edge;
        const width = Math.max(0, Math.min(edge, level.width - x0));
        const height = Math.max(0, Math.min(edge, level.height - y0));
        const costBytes = virtualTexturePageCostBytes(spec, mip);
        const data = new Uint8Array(costBytes);
        for (let row = 0; row < height; row++) {
          const sourceStart = (y0 + row) * level.bytesPerRow + x0 * spec.bytesPerTexel;
          data.set(level.data.subarray(sourceStart, sourceStart + width * spec.bytesPerTexel),
            row * edge * spec.bytesPerTexel);
        }
        const id = virtualTexturePageId(prepared.id, tileX, tileY, mip);
        if (pageByTile.has(id)) throw new Error(`Duplicate virtual texture page: ${id}.`);
        const page: VirtualTexturePage = Object.freeze({ id, textureId: prepared.id, tileX, tileY, mip,
          width, height, costBytes, data });
        pageByTile.set(id, page);
        pages.push(page);
        totalBytes += costBytes;
      }
    }
  }
  return Object.freeze({ textureId: prepared.id, spec: Object.freeze({ ...spec }), mipCount: prepared.levels.length,
    gridX, gridY, chainMips, pages: Object.freeze(pages), pageByTile, totalBytes });
}

function buildMipChain(source: DecodedTexture, levels: number): PixelLevel[] {
  // DecodedTexture.mipmaps excludes level 0; produce exactly levels-1 finer-to-coarser levels.
  const chain: PixelLevel[] = [boxDownsampleRgba8(source)];
  for (let index = 1; index < levels - 1; index++) chain.push(boxDownsampleRgba8(chain[index - 1]!));
  return chain;
}

function validateSpec(spec: VirtualTextureTileSpec): void {
  if (!spec || typeof spec !== "object") throw new TypeError("Virtual texture tile spec must be an object.");
  if (!Number.isSafeInteger(spec.tileEdgeTexels) || spec.tileEdgeTexels < 1
    || (spec.tileEdgeTexels & (spec.tileEdgeTexels - 1)) !== 0) {
    throw new RangeError("tileEdgeTexels must be a power-of-two safe integer.");
  }
  if (!Number.isSafeInteger(spec.bytesPerTexel) || spec.bytesPerTexel < 1) {
    throw new RangeError("bytesPerTexel must be a positive safe integer.");
  }
}
