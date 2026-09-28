import type { VirtualTexturePageTable } from "./virtualTexturePageTable.js";

/**
 * T06 page-fault and thrash diagnostics for the virtual-texture page table.
 *
 * Page-fault resolution is legal by construction: the table keeps every mip
 * chain a contiguous prefix, so when a wanted tile mip is missing the sampler
 * falls back to the finest resident mip of the same chain, which is always a
 * legal lower mip. When nothing of the chain is resident the caller must use
 * its whole-texture fallback LOD (the existing GpuTextureResidencyUploader
 * path); the resolver reports that case explicitly instead of inventing data.
 *
 * The thrash detector counts swap churn and ping-pong re-admissions over a
 * rolling window; when churn exceeds a configurable rate for the configured
 * grace period it flags thrashing and reports a cooldown during which the
 * strategy is expected to raise dwell (see VirtualTexturePageTable
 * .setDwellFrames) so ping-pong cameras cannot swap in/out without bound.
 */

export type VirtualTextureSampleStatus = "resident" | "page-fault" | "fallback-texture";

export interface VirtualTextureSampleResolution {
  readonly status: VirtualTextureSampleStatus;
  /** Mip that may legally be sampled; null only for fallback-texture. */
  readonly resolvedMip: number | null;
  /** How many levels coarser than requested the resolution landed on. */
  readonly fallbackLevels: number | null;
}

/** Resolves the legal low-mip sample for a tile; never returns a non-resident mip. */
export function resolveVirtualTextureSample(table: VirtualTexturePageTable, textureId: string,
  tileX: number, tileY: number, requestedMip: number): VirtualTextureSampleResolution {
  if (!Number.isSafeInteger(requestedMip) || requestedMip < 0) {
    throw new RangeError("Requested mip must be a non-negative safe integer.");
  }
  const depth = table.residentMipDepth(textureId, tileX, tileY);
  if (depth < 0) return Object.freeze({ status: "fallback-texture", resolvedMip: null, fallbackLevels: null });
  if (requestedMip <= depth) {
    return Object.freeze({ status: "resident", resolvedMip: requestedMip, fallbackLevels: 0 });
  }
  return Object.freeze({ status: "page-fault", resolvedMip: depth, fallbackLevels: requestedMip - depth });
}

export interface TextureThrashDetectorConfig {
  /** Rolling window length in frames. */
  readonly windowFrames?: number;
  /** Swap (admit + evict) budget per frame before a frame counts as hot. */
  readonly maxSwapsPerFrame?: number;
  /** Re-admitting a page within this many frames after eviction counts as ping-pong. */
  readonly pingPongWindowFrames?: number;
  /** Consecutive hot frames required before thrashing is flagged. */
  readonly graceFrames?: number;
  /** Frames the flag stays raised once triggered. */
  readonly cooldownFrames?: number;
}

export interface TextureThrashSnapshot {
  readonly frame: number;
  readonly swapsThisFrame: number;
  readonly windowSwaps: number;
  readonly swapsPerFrame: number;
  readonly pingPongCount: number;
  readonly thrashStreak: number;
  readonly thrashing: boolean;
  readonly cooldownRemainingFrames: number;
}

interface ResolvedThrashConfig extends Record<keyof TextureThrashDetectorConfig, number> {
  windowFrames: number; maxSwapsPerFrame: number; pingPongWindowFrames: number;
  graceFrames: number; cooldownFrames: number;
}

const DEFAULT_THRASH_CONFIG: ResolvedThrashConfig = Object.freeze({
  windowFrames: 16, maxSwapsPerFrame: 4, pingPongWindowFrames: 8, graceFrames: 2, cooldownFrames: 8,
});

/** Deterministic, counter-only thrash detector over the page table's plans. */
export class TextureThrashDetector {
  private readonly config: ResolvedThrashConfig;
  private readonly lastEvictedFrame = new Map<string, number>();
  private readonly window: { frame: number; swaps: number }[] = [];
  private pingPong = 0;
  private streak = 0;
  private cooldownUntil = -1;
  private latest: TextureThrashSnapshot = Object.freeze({
    frame: -1, swapsThisFrame: 0, windowSwaps: 0, swapsPerFrame: 0, pingPongCount: 0,
    thrashStreak: 0, thrashing: false, cooldownRemainingFrames: 0,
  });

  constructor(config: TextureThrashDetectorConfig = {}) {
    validateThrashConfig(config);
    this.config = { ...DEFAULT_THRASH_CONFIG, ...config };
  }

  get thrashing(): boolean { return this.latest.thrashing; }
  get snapshot(): TextureThrashSnapshot { return this.latest; }

  /** Feed one frame's plan outcome; frames must advance without gaps. */
  observe(frame: number, admittedIds: readonly string[], evictedIds: readonly string[]): TextureThrashSnapshot {
    if (!Number.isSafeInteger(frame) || frame < 0) throw new RangeError("Frame index must be a non-negative safe integer.");
    if (frame > 0 && frame !== this.latest.frame + 1) {
      throw new RangeError(`Thrash detector frames must advance without gaps (expected ${this.latest.frame + 1}, got ${frame}).`);
    }
    const admitted = validateIds(admittedIds), evicted = validateIds(evictedIds);
    while (this.window.length > 0 && frame - this.window[0]!.frame >= this.config.windowFrames) this.window.shift();
    for (const id of evicted) this.lastEvictedFrame.set(id, frame);
    for (const id of admitted) {
      const evictedAt = this.lastEvictedFrame.get(id);
      if (evictedAt !== undefined && frame - evictedAt <= this.config.pingPongWindowFrames) this.pingPong += 1;
    }
    for (const [id, evictedAt] of [...this.lastEvictedFrame]) {
      if (frame - evictedAt > this.config.pingPongWindowFrames) this.lastEvictedFrame.delete(id);
    }
    const swaps = admitted.length + evicted.length;
    this.window.push({ frame, swaps });
    const windowSwaps = this.window.reduce((sum, entry) => sum + entry.swaps, 0);
    if (swaps > this.config.maxSwapsPerFrame) this.streak += 1; else this.streak = 0;
    if (this.streak >= this.config.graceFrames) this.cooldownUntil = frame + this.config.cooldownFrames;
    const thrashing = frame < this.cooldownUntil;
    this.latest = Object.freeze({
      frame, swapsThisFrame: swaps, windowSwaps, swapsPerFrame: windowSwaps / Math.max(1, this.window.length),
      pingPongCount: this.pingPong, thrashStreak: this.streak, thrashing,
      cooldownRemainingFrames: Math.max(0, this.cooldownUntil - frame),
    });
    return this.latest;
  }
}

function validateIds(ids: readonly string[]): readonly string[] {
  if (!Array.isArray(ids)) throw new TypeError("Thrash detector expects id arrays.");
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0) throw new TypeError("Thrash detector ids must be non-empty strings.");
  }
  return ids;
}

function validateThrashConfig(config: TextureThrashDetectorConfig): void {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("Thrash detector config must be an object.");
  }
  const ranges: [keyof TextureThrashDetectorConfig, number][] = [
    ["windowFrames", 1], ["maxSwapsPerFrame", 0], ["pingPongWindowFrames", 0],
    ["graceFrames", 1], ["cooldownFrames", 0],
  ];
  for (const [key, minimum] of ranges) {
    const value = config[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum || value > 4096)) {
      throw new RangeError(`Thrash detector config ${String(key)} must be a safe integer from ${minimum} through 4096.`);
    }
  }
}
