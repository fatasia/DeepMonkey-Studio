import { chainKeyOf, MAX_VIRTUAL_TEXTURE_MIPS, validatePageRequest, validateSpec,
  type VirtualTexturePageRequest } from "./virtualTextureRequests.js";
import type { VirtualTextureTileSpec } from "./virtualTexturePages.js";
import { virtualTexturePageId } from "./virtualTexturePages.js";

/**
 * T06 virtual-texture page table and residency strategy (CPU logic only).
 *
 * Admission prefers the lowest mip first, then the highest visibility weight,
 * and keeps every mip chain a contiguous prefix: a resident page at mip m
 * always has mips 0..m-1 resident, so a legal low-mip fallback always exists.
 * Reclamation is pressure-driven LRU plus explicit texture eviction; pages
 * never requested again simply age out when the budget needs room, so frozen
 * cameras produce zero churn by construction. Upload admissions are in-flight
 * until commit; cancellation rolls them back without leaking references, and
 * commit/rollback are transactional (validated before any state mutates).
 * The prototype is NOT wired into the default renderer.
 */

export { buildVirtualTexturePageRequests, MAX_VIRTUAL_TEXTURE_MIPS } from "./virtualTextureRequests.js";
export type { VirtualTextureFootprint, VirtualTexturePageRequest } from "./virtualTextureRequests.js";

export interface VirtualTextureBudget {
  readonly maxBytes: number;
  readonly maxPages?: number;
  /** Dwell protection: a page is evictable only after this many resident frames. */
  readonly minResidentFrames?: number;
}

export interface VirtualTexturePageHandle {
  readonly id: string;
  readonly textureId: string;
  readonly tileX: number;
  readonly tileY: number;
  readonly mip: number;
  readonly costBytes: number;
  readonly weight: number;
  readonly lastUsedFrame: number;
  readonly inflight: boolean;
}

export interface VirtualTextureFrameStats {
  readonly frame: number;
  readonly requestCount: number;
  readonly residentCount: number;
  readonly inflightCount: number;
  readonly residentBytes: number;
  readonly budgetBytes: number;
  readonly admittedCount: number;
  readonly evictedCount: number;
  readonly deferredCount: number;
  readonly budgetUtilization: number;
}

export interface VirtualTextureResidencyPlan {
  readonly frame: number;
  readonly admitted: readonly VirtualTexturePageHandle[];
  readonly evicted: readonly VirtualTexturePageHandle[];
  readonly deferred: readonly VirtualTexturePageRequest[];
  readonly resident: readonly VirtualTexturePageHandle[];
  readonly stats: VirtualTextureFrameStats;
}

interface ResidentEntry {
  request: VirtualTexturePageRequest;
  lastUsedFrame: number;
  admittedFrame: number;
  inflight: boolean;
}

/**
 * Frame-driven texture page table: hard byte budget, mip-prefix admission,
 * LRU reclaim protected by dwell and in-flight state, and transactional
 * commit/rollback for upload cancellation aligned with the T11 executor.
 */
export class VirtualTexturePageTable {
  private readonly resident = new Map<string, ResidentEntry>();
  private residentBytes = 0;
  private rolledBack = 0;
  private minResidentFrames: number;

  constructor(private readonly spec: VirtualTextureTileSpec, private readonly budget: VirtualTextureBudget) {
    validateSpec(spec);
    if (!Number.isSafeInteger(budget.maxBytes) || budget.maxBytes < 1) {
      throw new RangeError("Virtual texture budget maxBytes must be a positive safe integer.");
    }
    if (budget.maxPages !== undefined
      && (!Number.isSafeInteger(budget.maxPages) || budget.maxPages < 1)) {
      throw new RangeError("Virtual texture budget maxPages must be a positive safe integer.");
    }
    this.minResidentFrames = validateDwell(budget.minResidentFrames ?? 0);
  }

  get residentCount(): number { return this.resident.size; }
  get residentByteCount(): number { return this.residentBytes; }
  get inflightCount(): number { return [...this.resident.values()].filter(entry => entry.inflight).length; }
  get rolledBackCount(): number { return this.rolledBack; }
  get dwellFrames(): number { return this.minResidentFrames; }
  /** Thrash backoff hook: raises dwell so ping-pong cameras throttle swap rate. */
  setDwellFrames(frames: number): void { this.minResidentFrames = validateDwell(frames); }

  plan(requests: readonly VirtualTexturePageRequest[], frame: number): VirtualTextureResidencyPlan {
    if (!Number.isSafeInteger(frame) || frame < 0) throw new RangeError("Frame index must be a non-negative safe integer.");
    const requested = new Map<string, VirtualTexturePageRequest>();
    for (const request of requests) {
      validatePageRequest(request, this.spec);
      if (requested.has(request.id)) throw new Error(`Duplicate virtual texture request: ${request.id}.`);
      requested.set(request.id, request);
    }

    const admitted: VirtualTexturePageHandle[] = [];
    const evicted: VirtualTexturePageHandle[] = [];
    const deferred: VirtualTexturePageRequest[] = [];
    const chainAdmitted = new Set<string>();
    const drop = (id: string): void => {
      const entry = this.resident.get(id);
      if (!entry) return;
      evicted.push(this.handle(entry));
      this.resident.delete(id);
      this.residentBytes -= entry.request.costBytes;
    };

    // Lowest mip first, then highest weight, then stable id order.
    const candidates = [...requested.values()].sort((left, right) => left.mip - right.mip
      || right.weight - left.weight || left.id.localeCompare(right.id));
    for (const candidate of candidates) {
      const chain = chainKeyOf(candidate);
      const entry = this.resident.get(candidate.id);
      if (entry) { entry.lastUsedFrame = frame; chainAdmitted.add(chain); continue; }
      if (!this.chainPrefixResident(chain, candidate.mip, chainAdmitted)) { deferred.push(candidate); continue; }
      if (this.tryAdmit(candidate, frame)) {
        admitted.push(this.handle(this.resident.get(candidate.id)!)); chainAdmitted.add(chain); continue;
      }
      if (this.evictUntilFits(candidate.costBytes, requested, frame, drop) && this.tryAdmit(candidate, frame)) {
        admitted.push(this.handle(this.resident.get(candidate.id)!)); chainAdmitted.add(chain);
      } else deferred.push(candidate);
    }

    const resident = [...this.resident.values()].map(entry => this.handle(entry))
      .sort((left, right) => left.id.localeCompare(right.id));
    const stats: VirtualTextureFrameStats = Object.freeze({
      frame, requestCount: requested.size, residentCount: resident.length, inflightCount: this.inflightCount,
      residentBytes: this.residentBytes, budgetBytes: this.budget.maxBytes, admittedCount: admitted.length,
      evictedCount: evicted.length, deferredCount: deferred.length,
      budgetUtilization: this.residentBytes / this.budget.maxBytes,
    });
    return Object.freeze({ frame, admitted: Object.freeze(admitted), evicted: Object.freeze(evicted),
      deferred: Object.freeze(deferred), resident, stats });
  }

  /** Marks uploaded pages usable; committed pages require a fully committed prefix. */
  commitAdmissions(ids: readonly string[]): void {
    this.transition(ids, entry => ({ ...entry, inflight: false }), "committed");
  }

  /** Rolls back cancelled uploads; committed pages reject rollback (boundary already passed). */
  rollbackAdmissions(ids: readonly string[]): void {
    const before = this.resident.size;
    this.transition(ids, entry => {
      if (!entry.inflight) {
        throw new Error(`Virtual texture page ${entry.request.id} is committed and cannot be rolled back.`);
      }
      return undefined;
    }, "resident");
    this.rolledBack += before - this.resident.size;
  }

  /** Evicts every committed page of one texture (T11 generation invalidation / release). */
  evictTexture(textureId: string): readonly VirtualTexturePageHandle[] {
    if (typeof textureId !== "string" || textureId.length === 0) throw new TypeError("Texture id must be a non-empty string.");
    const evicted: VirtualTexturePageHandle[] = [];
    for (const [id, entry] of [...this.resident.entries()]) {
      if (entry.request.textureId !== textureId) continue;
      if (entry.inflight) throw new Error(`Virtual texture page ${id} is in-flight and cannot be evicted.`);
      evicted.push(this.handle(entry));
      this.resident.delete(id);
      this.residentBytes -= entry.request.costBytes;
    }
    return Object.freeze(evicted);
  }

  /** Highest committed mip of a chain (-1 when none); in-flight uploads are not sampleable. */
  residentMipDepth(textureId: string, tileX: number, tileY: number): number {
    let depth = -1;
    for (let mip = 0; mip < MAX_VIRTUAL_TEXTURE_MIPS; mip++) {
      const entry = this.resident.get(virtualTexturePageId(textureId, tileX, tileY, mip));
      if (!entry || entry.inflight) break;
      depth = mip;
    }
    return depth;
  }

  /** Transactional batch transition: builds the post-state, validates, then swaps atomically. */
  private transition(ids: readonly string[], map: (entry: ResidentEntry) => ResidentEntry | undefined,
    mode: "resident" | "committed"): void {
    if (!Array.isArray(ids)) throw new TypeError("Virtual texture transition ids must be an array.");
    const unique = [...new Set(ids)];
    for (const id of unique) {
      if (typeof id !== "string" || !this.resident.has(id)) throw new Error(`Unknown virtual texture page: ${id}.`);
    }
    const next = new Map(this.resident);
    for (const id of unique) {
      const mapped = map(next.get(id)!);
      if (mapped) next.set(id, mapped); else next.delete(id);
    }
    this.assertPrefixInvariant(next, mode);
    this.resident.clear();
    let bytes = 0;
    for (const [id, entry] of next) { this.resident.set(id, entry); bytes += entry.request.costBytes; }
    this.residentBytes = bytes;
  }

  /**
   * "resident" mode: every resident page needs its full prefix resident
   * (admission invariant). "committed" mode: every committed page needs its
   * full prefix committed, because in-flight pages are not sampleable.
   */
  private assertPrefixInvariant(resident: ReadonlyMap<string, ResidentEntry>, mode: "resident" | "committed"): void {
    for (const entry of resident.values()) {
      if (mode === "committed" && entry.inflight) continue;
      const chain = chainKeyOf(entry.request);
      for (let level = 0; level < entry.request.mip; level++) {
        const prefix = resident.get(`${chain}|mip${level}`);
        if (!prefix || (mode === "committed" && prefix.inflight)) {
          throw new Error(`Virtual texture mip-prefix invariant violated for ${entry.request.id}.`);
        }
      }
    }
  }

  private chainPrefixResident(chain: string, mip: number, chainAdmitted: Set<string>): boolean {
    for (let level = 0; level < mip; level++) {
      if (!this.resident.has(`${chain}|mip${level}`) && !chainAdmitted.has(`${chain}|mip${level}`)) return false;
    }
    return true;
  }

  private tryAdmit(request: VirtualTexturePageRequest, frame: number): boolean {
    if (this.residentBytes + request.costBytes > this.budget.maxBytes) return false;
    if (this.budget.maxPages !== undefined && this.resident.size + 1 > this.budget.maxPages) return false;
    this.resident.set(request.id, { request, lastUsedFrame: frame, admittedFrame: frame, inflight: true });
    this.residentBytes += request.costBytes;
    return true;
  }

  /** Evicts LRU pages that are unrequested, committed and past dwell until costBytes fits. */
  private evictUntilFits(costBytes: number, requested: Map<string, VirtualTexturePageRequest>, frame: number,
    drop: (id: string) => void): boolean {
    const evictable = [...this.resident.entries()]
      .filter(([, entry]) => !requested.has(entry.request.id) && !entry.inflight
        && entry.lastUsedFrame < frame && frame - entry.admittedFrame >= this.minResidentFrames)
      .sort((left, right) => left[1].lastUsedFrame - right[1].lastUsedFrame
        || left[1].request.weight - right[1].request.weight || left[0].localeCompare(right[0]));
    while (evictable.length > 0
      && (this.residentBytes + costBytes > this.budget.maxBytes
        || (this.budget.maxPages !== undefined && this.resident.size + 1 > this.budget.maxPages))) {
      const [, victim] = evictable.shift()!;
      // Chains are evicted as a suffix: dropping mip k cascades to every higher
      // resident mip of the same chain so the mip-prefix invariant never breaks.
      drop(victim.request.id);
      for (let level = victim.request.mip + 1; level < MAX_VIRTUAL_TEXTURE_MIPS; level++) {
        const id = virtualTexturePageId(victim.request.textureId, victim.request.tileX,
          victim.request.tileY, level);
        if (!this.resident.has(id)) break;
        drop(id);
      }
    }
    return this.residentBytes + costBytes <= this.budget.maxBytes
      && (this.budget.maxPages === undefined || this.resident.size + 1 <= this.budget.maxPages);
  }

  private handle(entry: ResidentEntry): VirtualTexturePageHandle {
    return Object.freeze({ id: entry.request.id, textureId: entry.request.textureId, tileX: entry.request.tileX,
      tileY: entry.request.tileY, mip: entry.request.mip, costBytes: entry.request.costBytes,
      weight: entry.request.weight, lastUsedFrame: entry.lastUsedFrame, inflight: entry.inflight });
  }
}

function validateDwell(frames: number): number {
  if (!Number.isSafeInteger(frames) || frames < 0 || frames > 4096) {
    throw new RangeError("Virtual texture dwell frames must be a safe integer from 0 through 4096.");
  }
  return frames;
}
