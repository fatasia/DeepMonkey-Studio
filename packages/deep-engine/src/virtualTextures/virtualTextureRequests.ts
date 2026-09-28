import type { VirtualTextureTileSpec } from "./virtualTexturePages.js";
import { virtualTexturePageCostBytes, virtualTexturePageId } from "./virtualTexturePages.js";

/**
 * T06 virtual-texture footprint-to-request translation.
 *
 * A page is (tile, mip): the tile names a fixed mip-0 world region and each
 * mip is that same region at half resolution, so a chain keeps T04's
 * mip-prefix invariant and a missing page always falls back to a coarser mip
 * of the identical region. Mips 0..maxMip are requested together so admission
 * can keep every chain a prefix.
 */

export interface VirtualTextureFootprint {
  readonly textureId: string;
  readonly tileX: number;
  readonly tileY: number;
  /** Deepest wanted mip; mips 0..maxMip are requested as a prefix. */
  readonly maxMip: number;
  /** Visibility weight (coverage × demand priority); larger wins the budget. */
  readonly weight: number;
}

export interface VirtualTexturePageRequest {
  readonly id: string;
  readonly textureId: string;
  readonly tileX: number;
  readonly tileY: number;
  readonly mip: number;
  readonly weight: number;
  readonly costBytes: number;
}

export const MAX_VIRTUAL_TEXTURE_MIPS = 16;

/** Expands footprints into a deterministic, mip-prefixed, deduplicated request set. */
export function buildVirtualTexturePageRequests(footprints: readonly VirtualTextureFootprint[],
  spec: VirtualTextureTileSpec): readonly VirtualTexturePageRequest[] {
  if (!Array.isArray(footprints)) throw new TypeError("Virtual texture footprints must be an array.");
  validateSpec(spec);
  const requests = new Map<string, VirtualTexturePageRequest>();
  for (const footprint of footprints) {
    validateFootprint(footprint);
    for (let mip = 0; mip <= footprint.maxMip; mip++) {
      const id = virtualTexturePageId(footprint.textureId, footprint.tileX, footprint.tileY, mip);
      const previous = requests.get(id);
      if (previous && previous.weight >= footprint.weight) continue;
      requests.set(id, Object.freeze({ id, textureId: footprint.textureId, tileX: footprint.tileX,
        tileY: footprint.tileY, mip, weight: Math.max(previous?.weight ?? -1, footprint.weight),
        costBytes: virtualTexturePageCostBytes(spec, mip) }));
    }
  }
  return Object.freeze([...requests.values()]
    .sort((left, right) => left.mip - right.mip || left.id.localeCompare(right.id)));
}

export function chainKeyOf(request: Pick<VirtualTexturePageRequest, "textureId" | "tileX" | "tileY">): string {
  return `${request.textureId}|${request.tileX},${request.tileY}`;
}

export function validateSpec(spec: VirtualTextureTileSpec): void {
  if (!spec || typeof spec !== "object") throw new TypeError("Virtual texture tile spec must be an object.");
  if (!Number.isSafeInteger(spec.tileEdgeTexels) || spec.tileEdgeTexels < 1
    || (spec.tileEdgeTexels & (spec.tileEdgeTexels - 1)) !== 0
    || !Number.isSafeInteger(spec.bytesPerTexel) || spec.bytesPerTexel < 1) {
    throw new RangeError("Virtual texture tile spec is invalid.");
  }
}

export function validateFootprint(footprint: VirtualTextureFootprint): void {
  if (!footprint || typeof footprint !== "object") throw new TypeError("Virtual texture footprint must be an object.");
  if (typeof footprint.textureId !== "string" || footprint.textureId.trim().length === 0
    || footprint.textureId.includes("|")) {
    throw new TypeError("Virtual texture id must be a non-empty string without the '|' separator.");
  }
  if (!Number.isSafeInteger(footprint.tileX) || footprint.tileX < 0
    || !Number.isSafeInteger(footprint.tileY) || footprint.tileY < 0) {
    throw new RangeError("Virtual texture tile coordinates must be non-negative safe integers.");
  }
  if (!Number.isSafeInteger(footprint.maxMip) || footprint.maxMip < 0
    || footprint.maxMip >= MAX_VIRTUAL_TEXTURE_MIPS) {
    throw new RangeError(`Virtual texture maxMip for ${footprint.textureId} must be 0..${MAX_VIRTUAL_TEXTURE_MIPS - 1}.`);
  }
  if (!Number.isFinite(footprint.weight) || footprint.weight < 0) {
    throw new RangeError(`Virtual texture weight for ${footprint.textureId} must be a finite non-negative number.`);
  }
}

export function validatePageRequest(request: VirtualTexturePageRequest, spec: VirtualTextureTileSpec): void {
  if (!request || typeof request !== "object" || typeof request.id !== "string" || request.id.length === 0) {
    throw new TypeError("Virtual texture page request must carry a non-empty id.");
  }
  if (!Number.isSafeInteger(request.mip) || request.mip < 0 || request.mip >= MAX_VIRTUAL_TEXTURE_MIPS) {
    throw new RangeError(`Invalid mip for ${request.id}.`);
  }
  if (!Number.isFinite(request.weight) || request.weight < 0) throw new RangeError(`Invalid weight for ${request.id}.`);
  if (request.id !== virtualTexturePageId(request.textureId, request.tileX, request.tileY, request.mip)) {
    throw new Error(`Virtual texture page id must match textureId|tx,ty|mip: ${request.id}.`);
  }
  // Requests priced under a different tile spec would silently corrupt the budget.
  if (request.costBytes !== virtualTexturePageCostBytes(spec, request.mip)) {
    throw new RangeError(`Virtual texture page ${request.id} cost does not match the table tile spec.`);
  }
}
