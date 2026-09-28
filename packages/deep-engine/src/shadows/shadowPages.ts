import type { SharedShadowCubeFace } from "./sharedShadowAtlas.js";

/**
 * T04 experimental virtual-shadow paging prototype (CPU logic only).
 *
 * A page is one (light, face, mip) mip level of a local-light shadow face:
 * mip 0 is the full-resolution face and each higher mip quarters the byte
 * cost. Residency prefers the lowest mip first, then higher importance, and
 * the frame budget is a hard invariant. The prototype is NOT wired into the
 * default renderer; the shared atlas path stays authoritative until equal
 * image quality is proven.
 *
 * 不替换默认路径：消费方仍走 sharedShadowAtlas/级联阴影；本模块只做请求、
 * 驻留与回收的确定性策略与统计，供阶梯压力验证与后续 GPU 联调。
 */

export type ShadowPageKind = "point" | "spot";
export type ShadowPageFace = SharedShadowCubeFace;

export interface ShadowPageTileSpec {
  /** Full-resolution face edge in texels; higher mips halve it per level. */
  readonly tileEdgeTexels: number;
  readonly depthBytesPerTexel: number;
}

export const DEFAULT_SHADOW_PAGE_TILE: ShadowPageTileSpec =
  Object.freeze({ tileEdgeTexels: 256, depthBytesPerTexel: 4 });

const POINT_FACES = Object.freeze(["+x", "-x", "+y", "-y", "+z", "-z"] as const);

export interface ShadowLightPageRequest {
  readonly key: string;
  readonly kind: ShadowPageKind;
  /** Larger wins when the budget must choose; zero is allowed and ranks last. */
  readonly importance: number;
  /** Page-chain length: mips 0..mipLevels-1 are requested for every face. */
  readonly mipLevels: number;
}

export interface ShadowPageRequest {
  readonly id: string;
  readonly lightKey: string;
  /** Cube face for point lights; undefined for the single spot view. */
  readonly face: ShadowPageFace | undefined;
  readonly mip: number;
  readonly importance: number;
  readonly costBytes: number;
}

export function shadowPageCostBytes(spec: ShadowPageTileSpec, mip: number): number {
  const edge = spec.tileEdgeTexels >> mip;
  return Math.max(1, edge) * Math.max(1, edge) * spec.depthBytesPerTexel;
}

export function facesForKind(kind: ShadowPageKind): readonly (ShadowPageFace | undefined)[] {
  return kind === "point" ? POINT_FACES : Object.freeze([undefined]);
}

/** Expands light requests into a deterministic, mip-prefixed page request set. */
export function buildShadowPageRequests(lights: readonly ShadowLightPageRequest[],
  spec: ShadowPageTileSpec = DEFAULT_SHADOW_PAGE_TILE): readonly ShadowPageRequest[] {
  validateSpec(spec);
  const seen = new Set<string>();
  const requests: ShadowPageRequest[] = [];
  for (const light of lights) {
    validateLightRequest(light);
    for (let mip = 0; mip < light.mipLevels; mip++) {
      for (const face of facesForKind(light.kind)) {
        const id = pageId(light.key, face, mip);
        if (seen.has(id)) throw new Error(`Duplicate shadow page request: ${id}.`);
        seen.add(id);
        requests.push(Object.freeze({ id, lightKey: light.key, face, mip,
          importance: light.importance, costBytes: shadowPageCostBytes(spec, mip) }));
      }
    }
  }
  return Object.freeze(requests);
}

export function pageId(lightKey: string, face: ShadowPageFace | undefined, mip: number): string {
  return `${lightKey}|${face ?? "spot"}|mip${mip}`;
}

export interface ShadowPageBudget {
  readonly maxBytes: number;
  readonly maxPages?: number;
}

export interface ShadowPageHandle {
  readonly id: string;
  readonly lightKey: string;
  readonly face: ShadowPageFace | undefined;
  readonly mip: number;
  readonly costBytes: number;
  readonly importance: number;
  readonly lastUsedFrame: number;
}

export interface ShadowPageFrameStats {
  readonly frame: number;
  readonly requestCount: number;
  readonly residentCount: number;
  readonly residentBytes: number;
  readonly budgetBytes: number;
  readonly admittedCount: number;
  readonly evictedCount: number;
  readonly deferredCount: number;
  readonly lightsWithPages: number;
  readonly lightsDeferred: number;
  readonly budgetUtilization: number;
}

export interface ShadowResidencyPlan {
  readonly frame: number;
  readonly admitted: readonly ShadowPageHandle[];
  readonly evicted: readonly ShadowPageHandle[];
  readonly deferred: readonly ShadowPageRequest[];
  readonly resident: readonly ShadowPageHandle[];
  readonly stats: ShadowPageFrameStats;
}

interface ResidentEntry {
  request: ShadowPageRequest;
  lastUsedFrame: number;
}

/**
 * Frame-driven page table: requests touch residency, the budget is hard,
 * admission prefers low mip and high importance, and eviction is LRU over
 * pages that were not requested this frame. Admission keeps the mip chain a
 * prefix so a resident page always has every lower mip resident too.
 */
export class ShadowPageTable {
  private readonly resident = new Map<string, ResidentEntry>();
  private residentBytes = 0;

  constructor(private readonly spec: ShadowPageTileSpec = DEFAULT_SHADOW_PAGE_TILE,
    private readonly budget: ShadowPageBudget) {
    validateSpec(spec);
    if (!Number.isSafeInteger(budget.maxBytes) || budget.maxBytes < 1) {
      throw new RangeError("Shadow page budget maxBytes must be a positive safe integer.");
    }
    if (budget.maxPages !== undefined
      && (!Number.isSafeInteger(budget.maxPages) || budget.maxPages < 1)) {
      throw new RangeError("Shadow page budget maxPages must be a positive safe integer.");
    }
  }

  get residentCount(): number { return this.resident.size; }
  get residentByteCount(): number { return this.residentBytes; }

  plan(requests: readonly ShadowPageRequest[], frame: number): ShadowResidencyPlan {
    if (!Number.isSafeInteger(frame) || frame < 0) throw new RangeError("Frame index must be a non-negative safe integer.");
    const requested = new Map<string, ShadowPageRequest>();
    for (const request of requests) {
      validatePageRequest(request, this.spec);
      if (requested.has(request.id)) throw new Error(`Duplicate shadow page request: ${request.id}.`);
      requested.set(request.id, request);
    }

    const admitted: ShadowPageHandle[] = [];
    const evicted: ShadowPageHandle[] = [];
    const deferred: ShadowPageRequest[] = [];
    const chainAdmitted = new Set<string>();
    const drop = (id: string): void => {
      const entry = this.resident.get(id);
      if (!entry) return;
      evicted.push(this.handle(entry.request, entry.lastUsedFrame));
      this.resident.delete(id);
      this.residentBytes -= entry.request.costBytes;
    };

    // Lowest mip first, then highest importance, then stable id order.
    const candidates = [...requested.values()].sort((left, right) => left.mip - right.mip
      || right.importance - left.importance || left.id.localeCompare(right.id));

    for (const candidate of candidates) {
      const chain = `${candidate.lightKey}|${candidate.face ?? "spot"}`;
      const residentEntry = this.resident.get(candidate.id);
      if (residentEntry) {
        residentEntry.lastUsedFrame = frame;
        chainAdmitted.add(chain);
        continue;
      }
      if (!this.chainPrefixResident(chain, candidate.mip, chainAdmitted)) { deferred.push(candidate); continue; }
      if (this.tryAdmit(candidate, frame)) {
        admitted.push(this.handle(candidate, frame));
        chainAdmitted.add(chain);
        continue;
      }
      if (!this.evictUntilFits(candidate.costBytes, requested, frame, drop) || !this.tryAdmit(candidate, frame)) {
        deferred.push(candidate);
      } else {
        admitted.push(this.handle(candidate, frame));
        chainAdmitted.add(chain);
      }
    }

    for (const id of this.resident.keys()) {
      if (!requested.has(id)) drop(id);
    }

    const resident = [...this.resident.values()]
      .map(entry => this.handle(entry.request, entry.lastUsedFrame))
      .sort((left, right) => left.id.localeCompare(right.id));
    const stats: ShadowPageFrameStats = Object.freeze({
      frame, requestCount: requested.size, residentCount: resident.length, residentBytes: this.residentBytes,
      budgetBytes: this.budget.maxBytes, admittedCount: admitted.length, evictedCount: evicted.length,
      deferredCount: deferred.length, lightsWithPages: distinctLights(resident.map(page => page.lightKey)).size,
      lightsDeferred: distinctLights(deferred.map(page => page.lightKey)).size,
      budgetUtilization: this.residentBytes / this.budget.maxBytes,
    });
    return Object.freeze({ frame, admitted: Object.freeze(admitted), evicted: Object.freeze(evicted),
      deferred: Object.freeze(deferred), resident, stats });
  }

  private chainPrefixResident(chain: string, mip: number, chainAdmitted: Set<string>): boolean {
    for (let level = 0; level < mip; level++) {
      if (!this.resident.has(`${chain}|mip${level}`) && !chainAdmitted.has(`${chain}|mip${level}`)) return false;
    }
    return true;
  }

  private tryAdmit(request: ShadowPageRequest, frame: number): boolean {
    if (this.residentBytes + request.costBytes > this.budget.maxBytes) return false;
    if (this.budget.maxPages !== undefined && this.resident.size + 1 > this.budget.maxPages) return false;
    this.resident.set(request.id, { request, lastUsedFrame: frame });
    this.residentBytes += request.costBytes;
    return true;
  }

  /**
   * Evicts LRU pages that were not requested this frame until `costBytes` fits.
   * Mip-prefix invariant: evicting a low mip must cascade to all resident higher mips of the
   * same (light, face); if any higher mip of that (light, face) is requested this frame, the
   * low-mip candidate is skipped instead — an admitted higher mip must never lose its prefix.
   */
  private evictUntilFits(costBytes: number, requested: Map<string, ShadowPageRequest>, frame: number,
    drop: (id: string) => void): boolean {
    const evictable = [...this.resident.entries()]
      .filter(([id, entry]) => !requested.has(id) && entry.lastUsedFrame < frame)
      .sort((left, right) => left[1].lastUsedFrame - right[1].lastUsedFrame
        || left[1].request.importance - right[1].request.importance || left[0].localeCompare(right[0]));
    const skipped = new Set<string>();
    let index = 0;
    while (index < evictable.length) {
      if (this.residentBytes + costBytes <= this.budget.maxBytes
        && (this.budget.maxPages === undefined || this.resident.size + 1 <= this.budget.maxPages)) return true;
      const [id, entry] = evictable[index++]!;
      if (skipped.has(id) || !this.resident.has(id)) continue;
      const suffixIds = this.protectedResidentSuffixIds(entry.request, requested);
      if (suffixIds === null) {
        skipped.add(id);
        continue;
      }
      for (const suffixId of suffixIds) drop(suffixId);
      drop(id);
    }
    return this.residentBytes + costBytes <= this.budget.maxBytes
      && (this.budget.maxPages === undefined || this.resident.size + 1 <= this.budget.maxPages);
  }

  /**
   * Returns the resident higher-mip page ids of the same (light, face) that must cascade-evict
   * with `request`, or null when any of them is requested this frame (prefix must stay).
   */
  private protectedResidentSuffixIds(request: ShadowPageRequest,
    requested: Map<string, ShadowPageRequest>): readonly string[] | null {
    const suffixIds: string[] = [];
    for (const [id, entry] of this.resident) {
      if (entry.request.lightKey !== request.lightKey || entry.request.face !== request.face
        || entry.request.mip <= request.mip) continue;
      if (requested.has(id)) return null;
      suffixIds.push(id);
    }
    return suffixIds.sort((left, right) => left.localeCompare(right));
  }

  private handle(request: ShadowPageRequest, lastUsedFrame: number): ShadowPageHandle {
    return Object.freeze({ id: request.id, lightKey: request.lightKey, face: request.face, mip: request.mip,
      costBytes: request.costBytes, importance: request.importance, lastUsedFrame });
  }
}

function distinctLights(keys: readonly string[]): Set<string> {
  return new Set(keys);
}

function validateSpec(spec: ShadowPageTileSpec): void {
  if (!spec || typeof spec !== "object") throw new TypeError("Shadow page tile spec must be an object.");
  if (!Number.isSafeInteger(spec.tileEdgeTexels) || spec.tileEdgeTexels < 1
    || (spec.tileEdgeTexels & (spec.tileEdgeTexels - 1)) !== 0) {
    throw new RangeError("tileEdgeTexels must be a power-of-two safe integer.");
  }
  if (!Number.isSafeInteger(spec.depthBytesPerTexel) || spec.depthBytesPerTexel < 1) {
    throw new RangeError("depthBytesPerTexel must be a positive safe integer.");
  }
}

function validateLightRequest(light: ShadowLightPageRequest): void {
  if (!light || typeof light !== "object") throw new TypeError("Shadow light page request must be an object.");
  if (typeof light.key !== "string" || light.key.trim().length === 0 || light.key.includes("|")) {
    throw new TypeError("Shadow light key must be a non-empty string without the '|' separator.");
  }
  if (light.kind !== "point" && light.kind !== "spot") throw new RangeError(`Invalid shadow light kind: ${String(light.kind)}.`);
  if (!Number.isFinite(light.importance) || light.importance < 0) throw new RangeError(`Invalid shadow importance for ${light.key}.`);
  if (!Number.isSafeInteger(light.mipLevels) || light.mipLevels < 1 || light.mipLevels > 16) {
    throw new RangeError(`Invalid mipLevels for ${light.key}; expected 1..16.`);
  }
}

function validatePageRequest(request: ShadowPageRequest, spec?: ShadowPageTileSpec): void {
  if (!request || typeof request !== "object" || typeof request.id !== "string" || request.id.length === 0) {
    throw new TypeError("Shadow page request must carry a non-empty id.");
  }
  if (!Number.isSafeInteger(request.mip) || request.mip < 0) throw new RangeError(`Invalid mip for ${request.id}.`);
  if (!Number.isSafeInteger(request.costBytes) || request.costBytes < 1) throw new RangeError(`Invalid costBytes for ${request.id}.`);
  if (!Number.isFinite(request.importance) || request.importance < 0) throw new RangeError(`Invalid importance for ${request.id}.`);
  if (request.id !== pageId(request.lightKey, request.face, request.mip)) {
    throw new Error(`Shadow page id must match lightKey|face|mip: ${request.id}.`);
  }
  // Requests priced under a different tile spec would silently corrupt the budget.
  if (spec && request.costBytes !== shadowPageCostBytes(spec, request.mip)) {
    throw new RangeError(`Shadow page ${request.id} cost ${request.costBytes} does not match the table tile spec.`);
  }
}
