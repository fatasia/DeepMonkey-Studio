import type { SpatialItemId } from "../spatial/types.js";
import { SceneTransformGraph } from "../scene/SceneTransformGraph.js";
import type { SceneLocalTrs } from "../scene/types.js";
import { AnimationBlendScratch, mixedTransform, type NodeAccumulator } from "./blending.js";
import { clipTime, sampleAnimationTrack } from "./sampling.js";
import {
  AnimationError,
  type AnimationClipInput,
  type AnimationFadeOptions,
  type AnimationFrameResult,
  type AnimationLayerInput,
  type AnimationLayerState,
  type SceneAnimationMixerConfiguration,
  type SceneAnimationMixerOptions,
  type SceneAnimationMixerStats,
  type ValidatedAnimationClip,
} from "./types.js";
import { DEEP_ANIMATION_LIMITS, validateClip, validateFade, validateFrameDelta, validateLayer, validateMixerOptions } from "./validation.js";

export { DEEP_ANIMATION_LIMITS } from "./validation.js";

/** Deterministic host-neutral TRS clip player and scene graph writer. */
export class SceneAnimationMixer<TNodeId extends SpatialItemId = string> {
  readonly options: Readonly<SceneAnimationMixerConfiguration>;
  private readonly clips = new Map<string, ValidatedAnimationClip<TNodeId>>();
  private readonly layers = new Map<SpatialItemId, AnimationLayerState<TNodeId>>();
  private readonly scratch = new AnimationBlendScratch<TNodeId>();
  private readonly sample = new Float64Array(4);
  private readonly basePoses = new Map<TNodeId, SceneLocalTrs>();
  private nextOrdinal = 0;
  private stateGeneration = 0;
  private stateRevision = 0;

  constructor(options: SceneAnimationMixerOptions = {}) {
    this.options = validateMixerOptions(options);
  }

  get generation(): number { return this.stateGeneration; }
  get revision(): number { return this.stateRevision; }
  get stats(): SceneAnimationMixerStats {
    return Object.freeze({ clips: this.clips.size, layers: this.layers.size,
      pooledNodeAccumulators: this.scratch.pooledCount, generation: this.stateGeneration, revision: this.stateRevision });
  }

  registerClip(input: AnimationClipInput<TNodeId>): void {
    const clip = validateClip(input, this.options);
    if (this.clips.has(clip.id)) throw new AnimationError("duplicate-clip", `Animation clip already exists: ${clip.id}.`);
    if (this.clips.size >= this.options.maxClips) throw new AnimationError("capacity-exceeded", "Animation clip capacity was exceeded.");
    this.clips.set(clip.id, clip);
    this.stateGeneration += 1;
  }

  removeClip(id: string): boolean {
    if (!this.clips.has(id)) return false;
    this.clips.delete(id);
    for (const [layerId, layer] of this.layers) if (layer.clipId === id) this.layers.delete(layerId);
    this.basePoses.clear();
    this.stateGeneration += 1;
    return true;
  }

  play(input: AnimationLayerInput<TNodeId>): void {
    if (this.layers.has(input?.id)) throw new AnimationError("duplicate-layer", `Animation layer already exists: ${String(input?.id)}.`);
    if (this.layers.size >= this.options.maxLayers) throw new AnimationError("capacity-exceeded", "Animation layer capacity was exceeded.");
    const layer = validateLayer(input, this.clips, this.options, this.nextOrdinal);
    this.nextOrdinal += 1;
    this.layers.set(layer.id, layer);
    this.stateGeneration += 1;
  }

  stop(layerId: SpatialItemId): boolean {
    const removed = this.layers.delete(layerId);
    if (removed) this.stateGeneration += 1;
    return removed;
  }

  seek(layerId: SpatialItemId, time: number): void {
    const layer = this.requireLayer(layerId);
    if (!Number.isFinite(time) || Math.abs(time) > 1e15) throw new AnimationError("invalid-time", "Animation seek time is invalid.");
    this.layers.set(layerId, Object.freeze({ ...layer, time }));
    this.stateGeneration += 1;
  }

  setTimeScale(layerId: SpatialItemId, timeScale: number): void {
    const layer = this.requireLayer(layerId);
    if (!Number.isFinite(timeScale) || Math.abs(timeScale) > 1_000_000) throw new AnimationError("invalid-time", "Animation time scale is invalid.");
    this.layers.set(layerId, Object.freeze({ ...layer, timeScale }));
    this.stateGeneration += 1;
  }

  fade(layerId: SpatialItemId, targetWeight: number, duration: number, options: AnimationFadeOptions = {}): void {
    const layer = this.requireLayer(layerId);
    validateFade(targetWeight, duration);
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new AnimationError("invalid-layer", "Animation fade options must be an object.");
    if (options.removeWhenComplete !== undefined && typeof options.removeWhenComplete !== "boolean") throw new AnimationError("invalid-layer", "removeWhenComplete must be boolean.");
    if (duration === 0) {
      if (options.removeWhenComplete) this.layers.delete(layerId);
      else this.layers.set(layerId, Object.freeze({ ...layer, weight: targetWeight, fade: null }));
    } else {
      this.layers.set(layerId, Object.freeze({ ...layer, fade: Object.freeze({ startWeight: layer.weight,
        targetWeight, duration, elapsed: 0, removeWhenComplete: options.removeWhenComplete ?? false }) }));
    }
    this.stateGeneration += 1;
  }

  crossFade(fromLayerId: SpatialItemId, to: AnimationLayerInput<TNodeId>, duration: number): void {
    const from = this.requireLayer(fromLayerId);
    if (!to || typeof to !== "object") throw new AnimationError("invalid-layer", "Cross-fade target layer must be an object.");
    if (fromLayerId === to?.id || this.layers.has(to?.id)) throw new AnimationError("duplicate-layer", "Cross-fade target layer id must be new.");
    validateFade(to.weight ?? 1, duration);
    if (duration > 0 && this.layers.size >= this.options.maxLayers) throw new AnimationError("capacity-exceeded", "Animation layer capacity was exceeded.");
    const desiredWeight = to.weight ?? 1;
    const target = validateLayer(to, this.clips, this.options, this.nextOrdinal, duration === 0 ? desiredWeight : 0);
    this.nextOrdinal += 1;
    if (duration === 0) this.layers.delete(fromLayerId);
    else this.layers.set(fromLayerId, Object.freeze({ ...from, fade: Object.freeze({ startWeight: from.weight,
      targetWeight: 0, duration, elapsed: 0, removeWhenComplete: true }) }));
    this.layers.set(target.id, duration === 0 ? target : Object.freeze({ ...target, fade: Object.freeze({ startWeight: 0,
      targetWeight: desiredWeight, duration, elapsed: 0, removeWhenComplete: false }) }));
    this.stateGeneration += 1;
  }

  sampleAndApply(graph: SceneTransformGraph<TNodeId>, deltaSeconds: number): AnimationFrameResult<TNodeId> {
    const delta = validateFrameDelta(deltaSeconds);
    if (!(graph instanceof SceneTransformGraph)) throw new AnimationError("graph-rejected", "Animation target must be a SceneTransformGraph.");
    const nextLayers = this.advanceLayers(delta);
    this.scratch.begin();
    let sampledTracks = 0;
    for (const layer of nextLayers) {
      if (layer.weight === 0) continue;
      const clip = this.clips.get(layer.clipId)!;
      const time = clipTime(clip, layer.time, layer.wrapMode);
      for (const track of clip.tracks) {
        if (layer.nodeMask && !layer.nodeMask.has(track.nodeId)) continue;
        const accumulator = this.accumulator(graph, track.nodeId);
        sampleAnimationTrack(track, time, this.sample);
        this.scratch.accumulate(accumulator, track, this.sample, layer.weight, layer.blendMode);
        sampledTracks += 1;
      }
    }
    const updated: TNodeId[] = [];
    try {
      graph.transaction((draft) => {
        for (const accumulator of this.scratch.ordered()) {
          const transform = mixedTransform(accumulator);
          if (sameTrs(transform, accumulator.current)) continue;
          draft.update(accumulator.id, { localTransform: transform });
          updated.push(accumulator.id);
        }
      });
    } catch (cause) {
      throw new AnimationError("graph-rejected", "Scene graph rejected the sampled animation frame.", { cause });
    }
    this.layers.clear();
    for (const layer of nextLayers) this.layers.set(layer.id, layer);
    this.retainActiveBasePoses(this.scratch.ordered());
    this.stateRevision += 1;
    return Object.freeze({ revision: this.stateRevision, graphGeneration: graph.generation,
      activeLayers: this.layers.size, sampledTracks, updatedNodeIds: Object.freeze(updated) });
  }

  private accumulator(graph: SceneTransformGraph<TNodeId>, id: TNodeId): NodeAccumulator<TNodeId> {
    const existing = this.scratch.get(id);
    if (existing) return existing;
    const snapshot = graph.getNode(id);
    if (!snapshot) throw new AnimationError("missing-node", `Animation target node does not exist: ${String(id)}.`);
    if (snapshot.localTransform.kind !== "trs") throw new AnimationError("matrix-target", `TRS animation cannot target matrix node ${String(id)} without explicit decomposition.`);
    const base = this.basePoses.get(id) ?? snapshot.localTransform;
    return this.scratch.acquire(id, base, snapshot.localTransform, this.options.maxAnimatedNodes);
  }

  private advanceLayers(delta: number): AnimationLayerState<TNodeId>[] {
    const result: AnimationLayerState<TNodeId>[] = [];
    const ordered = [...this.layers.values()].sort((left, right) => left.ordinal - right.ordinal);
    for (const layer of ordered) {
      const clip = this.clips.get(layer.clipId)!;
      const time = clipTime(clip, layer.time + delta * layer.timeScale, layer.wrapMode);
      if (!layer.fade) { result.push(Object.freeze({ ...layer, time })); continue; }
      const elapsed = Math.min(layer.fade.duration, layer.fade.elapsed + delta);
      const progress = elapsed / layer.fade.duration;
      const weight = layer.fade.startWeight + (layer.fade.targetWeight - layer.fade.startWeight) * progress;
      if (elapsed === layer.fade.duration && layer.fade.removeWhenComplete) continue;
      const fade = elapsed === layer.fade.duration ? null : Object.freeze({ ...layer.fade, elapsed });
      result.push(Object.freeze({ ...layer, time, weight, fade }));
    }
    return result;
  }

  private retainActiveBasePoses(active: readonly NodeAccumulator<TNodeId>[]): void {
    this.basePoses.clear();
    for (const accumulator of active) this.basePoses.set(accumulator.id, accumulator.base);
  }

  private requireLayer(id: SpatialItemId): AnimationLayerState<TNodeId> {
    const layer = this.layers.get(id);
    if (!layer) throw new AnimationError("missing-layer", `Animation layer does not exist: ${String(id)}.`);
    return layer;
  }
}

function sameTrs(left: SceneLocalTrs, right: SceneLocalTrs): boolean {
  return sameArray(left.translation, right.translation) && sameArray(left.rotation, right.rotation) && sameArray(left.scale, right.scale);
}
function sameArray(left: readonly number[], right: readonly number[]): boolean { return left.every((value, index) => value === right[index]); }
