import type { InstanceUpdate } from "../renderPacketTypes.js";
import type { SpatialItemId } from "../spatial/types.js";
import type { GpuMorphWeights } from "../webgpu/gpuMorphTypes.js";
import type { MorphSkinningDynamics } from "../webgpu/gpuMorphSkinningTypes.js";
import type { SkinningPalette } from "../webgpu/gpuSkinningTypes.js";
import { GltfRenderAnimationBridge } from "./renderAnimationBridge.js";
import type {
  GltfRenderAnimationBridgeOptions,
  GltfRenderAnimationFrame,
  GltfRenderAnimationSelection,
  GltfRenderAnimationSources,
} from "./renderAnimationBridgeTypes.js";

type UpdateResult = boolean | void;

export interface AnimationInstanceTarget {
  updateInstances(update: InstanceUpdate): UpdateResult;
}

export interface AnimationSkinTarget {
  updatePalette(palette: SkinningPalette): UpdateResult;
}

export interface AnimationMorphTarget {
  updateWeights(weights: GpuMorphWeights): UpdateResult;
}

export interface AnimationMorphSkinningTarget {
  updateDynamics(dynamics: MorphSkinningDynamics): UpdateResult;
}

/** Structural targets implemented by PbrRenderer and the existing GPU deformers. */
export interface GltfRenderAnimationTargets {
  readonly instances?: AnimationInstanceTarget;
  readonly skins?: ReadonlyMap<string, AnimationSkinTarget>;
  readonly morphs?: ReadonlyMap<string, AnimationMorphTarget>;
  readonly morphSkinning?: ReadonlyMap<string, AnimationMorphSkinningTarget>;
}

export interface GltfRenderAnimationApplication {
  readonly frameRevision: number;
  readonly invokedTargets: number;
  readonly changedTargets: number;
  readonly skippedTargets: number;
  readonly unbound: readonly string[];
}

export interface GltfRenderAnimationUpdate<TNodeId extends SpatialItemId> {
  readonly frame: GltfRenderAnimationFrame<TNodeId>;
  /** False when this call recovered a previously sampled frame without consuming deltaSeconds. */
  readonly advanced: boolean;
  readonly application: GltfRenderAnimationApplication;
}

export type GltfRenderAnimationRuntimeErrorCode = "invalid-targets" | "pending-frame" | "stale-frame";

export class GltfRenderAnimationRuntimeError extends Error {
  constructor(readonly code: GltfRenderAnimationRuntimeErrorCode, message: string) {
    super(message);
    this.name = "GltfRenderAnimationRuntimeError";
  }
}

/**
 * Owns the playhead-to-render submission boundary. A failed submission is retried
 * before another delta is consumed, so renderer recovery cannot skip animation time.
 */
export class GltfRenderAnimationRuntime<TNodeId extends SpatialItemId = number> {
  private readonly bridge: GltfRenderAnimationBridge<TNodeId>;
  private readonly applier: RenderAnimationFrameApplier<TNodeId>;
  private pending: GltfRenderAnimationFrame<TNodeId> | null = null;

  constructor(sources: GltfRenderAnimationSources<TNodeId>, targets: GltfRenderAnimationTargets,
    options: GltfRenderAnimationBridgeOptions<TNodeId> = {}) {
    this.bridge = new GltfRenderAnimationBridge(sources, options);
    this.applier = new RenderAnimationFrameApplier(targets);
  }

  get frame(): GltfRenderAnimationFrame<TNodeId> { return this.bridge.frame; }
  get time(): number { return this.bridge.time; }
  get isPaused(): boolean { return this.bridge.isPaused; }
  get isFinished(): boolean { return this.bridge.isFinished; }
  get hasPendingFrame(): boolean { return this.pending !== null; }

  update(deltaSeconds: number, signal?: AbortSignal): GltfRenderAnimationUpdate<TNodeId> {
    throwIfAborted(signal);
    if (this.pending) return this.submit(this.pending, false, signal);
    return this.submit(this.bridge.update(deltaSeconds), true, signal);
  }

  retry(signal?: AbortSignal): GltfRenderAnimationUpdate<TNodeId> {
    throwIfAborted(signal);
    return this.submit(this.pending ?? this.bridge.frame, false, signal);
  }

  play(selection: GltfRenderAnimationSelection = {}, signal?: AbortSignal): GltfRenderAnimationUpdate<TNodeId> {
    this.assertNoPending(); throwIfAborted(signal);
    return this.submit(this.bridge.play(selection), true, signal);
  }

  crossFade(selection: GltfRenderAnimationSelection, duration: number,
    signal?: AbortSignal): GltfRenderAnimationUpdate<TNodeId> {
    this.assertNoPending(); throwIfAborted(signal);
    return this.submit(this.bridge.crossFade(selection, duration), true, signal);
  }

  seek(time: number, signal?: AbortSignal): GltfRenderAnimationUpdate<TNodeId> {
    this.assertNoPending(); throwIfAborted(signal);
    return this.submit(this.bridge.seek(time), true, signal);
  }

  pause(): void { this.bridge.pause(); }
  resume(): void { this.bridge.resume(); }
  setTimeScale(value: number): void { this.bridge.setTimeScale(value); }

  private submit(frame: GltfRenderAnimationFrame<TNodeId>, advanced: boolean,
    signal: AbortSignal | undefined): GltfRenderAnimationUpdate<TNodeId> {
    try {
      const application = this.applier.apply(frame, signal);
      this.pending = null;
      return Object.freeze({ frame, advanced, application });
    } catch (error) {
      this.pending = frame;
      throw error;
    }
  }

  private assertNoPending(): void {
    if (this.pending) throw new GltfRenderAnimationRuntimeError("pending-frame",
      "Retry the pending animation frame before changing playback state.");
  }
}

interface FusedRevision { readonly morph: number; readonly skin: number }

class RenderAnimationFrameApplier<TNodeId extends SpatialItemId> {
  private readonly instanceRevisions = new WeakMap<object, number>();
  private readonly skinRevisions = new WeakMap<object, number>();
  private readonly morphRevisions = new WeakMap<object, number>();
  private readonly fusedRevisions = new WeakMap<object, FusedRevision>();
  private completedRevision = -1;

  constructor(private readonly targets: GltfRenderAnimationTargets) { validateTargets(targets); }

  apply(frame: GltfRenderAnimationFrame<TNodeId>, signal?: AbortSignal): GltfRenderAnimationApplication {
    validateFrameRevision(frame, this.completedRevision);
    let invoked = 0, changed = 0, skipped = 0;
    const unbound: string[] = [], fused = new Set<string>();
    for (const entry of frame.morphSkinning) {
      const target = this.targets.morphSkinning?.get(entry.primitiveId);
      if (!target) continue;
      const result = this.applyFused(target, entry.dynamics, signal);
      invoked += result.invoked; changed += result.changed; skipped += result.skipped; fused.add(entry.primitiveId);
    }
    for (const entry of frame.skinPalettes) for (const primitiveId of entry.primitiveIds) {
      if (fused.has(primitiveId)) continue;
      const target = this.targets.skins?.get(primitiveId);
      if (!target) { unbound.push(`skin:${primitiveId}`); continue; }
      const result = applyRevisioned(target, entry.palette, target.updatePalette, this.skinRevisions, signal);
      invoked += result.invoked; changed += result.changed; skipped += result.skipped;
    }
    for (const entry of frame.morphWeights) for (const primitiveId of entry.primitiveIds) {
      if (fused.has(primitiveId)) continue;
      const target = this.targets.morphs?.get(primitiveId);
      if (!target) { unbound.push(`morph:${primitiveId}`); continue; }
      const result = applyRevisioned(target, entry.weights, target.updateWeights, this.morphRevisions, signal);
      invoked += result.invoked; changed += result.changed; skipped += result.skipped;
    }
    if (frame.instanceUpdate) {
      const target = this.targets.instances;
      if (!target) unbound.push("instances");
      else {
        const result = applyRevisioned(target, { revision: frame.revision, value: frame.instanceUpdate },
          function (input) { return this.updateInstances(input.value); }, this.instanceRevisions, signal);
        invoked += result.invoked; changed += result.changed; skipped += result.skipped;
      }
    }
    this.completedRevision = frame.revision;
    return Object.freeze({ frameRevision: frame.revision, invokedTargets: invoked, changedTargets: changed,
      skippedTargets: skipped, unbound: Object.freeze(unbound) });
  }

  private applyFused(target: AnimationMorphSkinningTarget, dynamics: MorphSkinningDynamics,
    signal?: AbortSignal): ApplyCounts {
    const before = this.fusedRevisions.get(target), next = {
      morph: dynamics.morphWeights.revision, skin: dynamics.palette.revision,
    };
    if (before && (next.morph < before.morph || next.skin < before.skin)) stale("fused deformation");
    if (before && next.morph === before.morph && next.skin === before.skin) return SKIPPED;
    throwIfAborted(signal);
    const changed = target.updateDynamics(dynamics) !== false;
    this.fusedRevisions.set(target, next);
    return { invoked: 1, changed: changed ? 1 : 0, skipped: 0 };
  }
}

interface ApplyCounts { readonly invoked: number; readonly changed: number; readonly skipped: number }
const SKIPPED: ApplyCounts = Object.freeze({ invoked: 0, changed: 0, skipped: 1 });

function applyRevisioned<TTarget extends object, TValue extends { readonly revision: number }>(target: TTarget, value: TValue,
  update: (this: TTarget, value: TValue) => UpdateResult, revisions: WeakMap<object, number>, signal?: AbortSignal): ApplyCounts {
  const before = revisions.get(target);
  if (before !== undefined && value.revision < before) stale("animation target");
  if (before === value.revision) return SKIPPED;
  throwIfAborted(signal);
  const changed = update.call(target, value) !== false;
  revisions.set(target, value.revision);
  return { invoked: 1, changed: changed ? 1 : 0, skipped: 0 };
}

function validateTargets(targets: GltfRenderAnimationTargets): void {
  if (!targets || typeof targets !== "object" || Array.isArray(targets)) invalidTargets();
  if (!validateTarget(targets.instances, "updateInstances")) invalidTargets();
  validateTargetMap(targets.skins, "updatePalette");
  validateTargetMap(targets.morphs, "updateWeights"); validateTargetMap(targets.morphSkinning, "updateDynamics");
}
function validateTargetMap(value: ReadonlyMap<string, object> | undefined, method: string): void {
  if (value === undefined) return;
  if (!(value instanceof Map)) invalidTargets();
  for (const [id, target] of value) if (!id || typeof id !== "string" || !validateTarget(target, method)) invalidTargets();
}
function validateTarget(value: object | undefined, method: string): boolean {
  if (value === undefined) return true;
  return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>)[method] === "function";
}
function validateFrameRevision(frame: { readonly revision: number }, completed: number): void {
  if (!Number.isSafeInteger(frame?.revision) || frame.revision < 0) {
    throw new GltfRenderAnimationRuntimeError("stale-frame", "Animation frame revision is invalid.");
  }
  if (frame.revision < completed) stale("frame");
}
function stale(label: string): never {
  throw new GltfRenderAnimationRuntimeError("stale-frame", `Cannot apply a stale ${label} revision.`);
}
function invalidTargets(): never {
  throw new GltfRenderAnimationRuntimeError("invalid-targets", "Animation render targets are invalid.");
}
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) signal.throwIfAborted(); }
