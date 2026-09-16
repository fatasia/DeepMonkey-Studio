import { SceneTransformGraph } from "../scene/SceneTransformGraph.js";
import type { SpatialItemId } from "../spatial/types.js";
import type { AnimationClipInput, AnimationWrapMode } from "../animation/types.js";
import type { MorphWeightClip } from "../morph/types.js";
import type { GltfAnimatedNode } from "./animationTypes.js";
import {
  commitBankState, createBridgeBank, createBridgeLayout, fillBridgeBank, initializeBankState, sameBridgeBank,
  type BridgeBank, type BridgeLayout, type BridgeMorphPose, type BridgeMorphSample,
} from "./renderAnimationBridgeBuffers.js";
import type {
  GltfRenderAnimationBridgeOptions, GltfRenderAnimationFrame, GltfRenderAnimationSelection, GltfRenderAnimationSources,
} from "./renderAnimationBridgeTypes.js";
import { GltfRenderAnimationBridgeError } from "./renderAnimationBridgeTypes.js";
import {
  prepareMixer, resolvedSelection, resolveBridgeSources, validateBridgeOptions, validateCrossFadeDuration,
  validateFrameDelta, validateMorphTracks, validateTime, validateTimeScale,
} from "./renderAnimationBridgeValidation.js";

const TRANSFORM_LAYER_PREFIX = "__deep_gltf_render_bridge__";

interface BridgeTransition<TNodeId extends SpatialItemId> {
  readonly fromMorphClip: MorphWeightClip<TNodeId> | null;
  readonly fromMorphPose: readonly Float32Array<ArrayBuffer>[] | null;
  fromTime: number;
  readonly fromTimeScale: number;
  readonly fromWrapMode: AnimationWrapMode;
  readonly targetLayerId: string | null;
  elapsed: number;
  readonly duration: number;
}

/** Bridges owned glTF animation data to reusable render and GPU deformation updates. */
export class GltfRenderAnimationBridge<TNodeId extends SpatialItemId = number> {
  private readonly source;
  private readonly graph: SceneTransformGraph<TNodeId>;
  private readonly mixer;
  private readonly layout: BridgeLayout<TNodeId>;
  private readonly banks: readonly [BridgeBank<TNodeId>, BridgeBank<TNodeId>];
  private activeBank: 0 | 1 = 0;
  private stateRevision = 0;
  private transformClip: AnimationClipInput<TNodeId> | null = null;
  private morphClip: MorphWeightClip<TNodeId> | null = null;
  private wrapMode: AnimationWrapMode = "loop";
  private playbackMode: "loop" | "once" = "loop";
  private playhead = 0;
  private timeScale = 1;
  private paused = false;
  private finished = false;
  private activeLayerId: string | null = null;
  private transition: BridgeTransition<TNodeId> | null = null;
  private nextLayerOrdinal = 0;

  constructor(sources: GltfRenderAnimationSources<TNodeId>, options: GltfRenderAnimationBridgeOptions<TNodeId> = {}) {
    this.source = resolveBridgeSources(sources);
    const nodeIds = new Set(this.source.nodes.map(({ id }) => id));
    validateBridgeOptions(options, nodeIds); validateMorphTracks(this.source, nodeIds);
    this.graph = createGraph(this.source.nodes);
    this.mixer = prepareMixer(this.source.transformClips, this.source.nodes.length);
    this.layout = createBridgeLayout(this.source);
    this.banks = [createBridgeBank(this.layout, options), createBridgeBank(this.layout, options)];
    this.select(options.selection);
    this.applyTransformPose(0);
    fillBridgeBank(this.banks[0], this.layout, this.graph, this.morphSamples());
    fillBridgeBank(this.banks[1], this.layout, this.graph, this.morphSamples());
    initializeBankState(this.banks[0], 0, this.playhead, this.paused, this.finished);
    initializeBankState(this.banks[1], 0, this.playhead, this.paused, this.finished);
  }

  get frame(): GltfRenderAnimationFrame<TNodeId> { return this.banks[this.activeBank].frame; }
  get revision(): number { return this.stateRevision; }
  get time(): number { return this.playhead; }
  get isPaused(): boolean { return this.paused; }
  get isFinished(): boolean { return this.finished; }

  /** Selects synchronized clips and applies their requested starting pose immediately. */
  play(selection: GltfRenderAnimationSelection = {}): GltfRenderAnimationFrame<TNodeId> {
    const resolved = resolvedSelection(this.source, selection);
    assertMatchingDuration(this.source.transformClips, resolved.transformClipId, this.source.morphClips, resolved.morphClipId);
    this.resetGraphPose();
    this.clearTransformLayers();
    this.assignSelection(resolved);
    this.startCurrentTransformLayer();
    return this.renderCurrentPose();
  }

  crossFade(selection: GltfRenderAnimationSelection, duration: number): GltfRenderAnimationFrame<TNodeId> {
    validateCrossFadeDuration(duration);
    if (duration === 0) return this.play(selection);
    const resolved = resolvedSelection(this.source, selection);
    assertMatchingDuration(this.source.transformClips, resolved.transformClipId, this.source.morphClips, resolved.morphClipId);
    const interruptedPose = this.transition ? this.captureMorphPose() : null;
    const from = { morphClip: interruptedPose ? null : this.morphClip, time: this.playhead,
      timeScale: this.timeScale, wrapMode: this.wrapMode };
    if (interruptedPose) {
      this.clearTransformLayers();
      this.mixer.rebaseFromCurrentGraphPose();
    }
    const targetTransform = findClip(this.source.transformClips, resolved.transformClipId);
    const targetLayerId = targetTransform ? this.layerId() : null;
    if (this.activeLayerId) this.mixer.setTimeScale(this.activeLayerId, from.timeScale);
    if (targetTransform && this.activeLayerId) this.mixer.crossFade(this.activeLayerId, { id: targetLayerId!, clipId: targetTransform.id,
      time: resolved.time, timeScale: resolved.timeScale, wrapMode: resolved.wrapMode }, duration);
    else if (targetTransform) {
      this.mixer.play({ id: targetLayerId!, clipId: targetTransform.id, time: resolved.time,
        timeScale: resolved.timeScale, wrapMode: resolved.wrapMode, weight: 0 });
      this.mixer.fade(targetLayerId!, 1, duration);
    } else if (this.activeLayerId) this.mixer.fade(this.activeLayerId, 0, duration, { removeWhenComplete: true });
    this.assignSelection(resolved);
    this.transition = { fromMorphClip: from.morphClip, fromMorphPose: interruptedPose, fromTime: from.time,
      fromTimeScale: from.timeScale,
      fromWrapMode: from.wrapMode, targetLayerId, elapsed: 0, duration };
    this.finished = false;
    return this.renderCurrentPose();
  }

  pause(): void { this.paused = true; this.setCurrentFrameState(); }
  resume(): void { this.paused = false; this.setCurrentFrameState(); }
  setTimeScale(value: number): void {
    validateTimeScale(value); this.timeScale = value;
    if (this.transition?.targetLayerId) this.mixer.setTimeScale(this.transition.targetLayerId, value);
  }

  seek(time: number): GltfRenderAnimationFrame<TNodeId> {
    validateTime(time); this.playhead = normalizeTime(time, this.duration(), this.wrapMode);
    if (this.transition?.targetLayerId) this.mixer.seek(this.transition.targetLayerId, this.playhead);
    this.finished = !this.transition && terminal(this.playhead, this.duration(), this.timeScale, this.playbackMode);
    return this.renderCurrentPose();
  }

  update(deltaSeconds: number): GltfRenderAnimationFrame<TNodeId> {
    validateFrameDelta(deltaSeconds);
    const delta = this.paused ? 0 : deltaSeconds;
    if (this.transition) {
      this.transition.fromTime = normalizeTime(this.transition.fromTime + delta * this.transition.fromTimeScale,
        this.transition.fromMorphClip?.duration ?? 0, this.transition.fromWrapMode);
      this.playhead = normalizeTime(this.playhead + delta * this.timeScale, this.duration(), this.wrapMode);
      this.transition.elapsed = Math.min(this.transition.duration, this.transition.elapsed + delta);
      return this.renderCurrentPose(delta);
    }
    this.playhead = normalizeTime(this.playhead + delta * this.timeScale, this.duration(), this.wrapMode);
    this.finished = terminal(this.playhead, this.duration(), this.timeScale, this.playbackMode);
    return this.renderCurrentPose();
  }

  private select(selection: GltfRenderAnimationSelection | undefined): void {
    const resolved = resolvedSelection(this.source, selection);
    assertMatchingDuration(this.source.transformClips, resolved.transformClipId, this.source.morphClips, resolved.morphClipId);
    this.assignSelection(resolved);
    this.startCurrentTransformLayer();
  }

  private assignSelection(selection: { transformClipId: string | null; morphClipId: string | null; wrapMode: AnimationWrapMode;
    playbackMode: "loop" | "once"; time: number; timeScale: number; paused: boolean }): void {
    this.transformClip = findClip(this.source.transformClips, selection.transformClipId);
    this.morphClip = findClip(this.source.morphClips, selection.morphClipId);
    this.wrapMode = selection.wrapMode; this.playbackMode = selection.playbackMode;
    this.timeScale = selection.timeScale; this.paused = selection.paused;
    this.playhead = normalizeTime(selection.time, this.duration(), this.wrapMode);
    this.finished = terminal(this.playhead, this.duration(), this.timeScale, this.playbackMode);
  }

  private renderCurrentPose(delta = 0): GltfRenderAnimationFrame<TNodeId> {
    this.applyTransformPose(delta);
    const next = this.activeBank === 0 ? 1 : 0;
    fillBridgeBank(this.banks[next], this.layout, this.graph, this.morphSamples(), this.morphPose());
    if (!sameBridgeBank(this.banks[this.activeBank], this.banks[next])) {
      this.stateRevision += 1;
      commitBankState(this.banks[this.activeBank], this.banks[next], this.stateRevision, this.playhead, this.paused, this.finished);
      this.activeBank = next;
    }
    const transition = this.transition;
    if (transition && transition.elapsed === transition.duration) this.completeTransition();
    this.setCurrentFrameState();
    return this.banks[this.activeBank].frame;
  }

  private applyTransformPose(delta: number): void {
    if (this.transition) { this.mixer.sampleAndApply(this.graph, delta); return; }
    if (!this.transformClip || !this.activeLayerId) return;
    this.mixer.seek(this.activeLayerId, this.playhead);
    this.mixer.sampleAndApply(this.graph, 0);
  }

  private resetGraphPose(): void {
    this.graph.transaction((draft) => { for (const node of this.source.nodes) draft.update(node.id, { localTransform: node.localTransform }); });
  }

  private setCurrentFrameState(): void {
    const frame = this.banks[this.activeBank].frame;
    frame.revision = this.stateRevision; frame.time = this.playhead; frame.paused = this.paused; frame.finished = this.finished;
  }

  private morphSamples(): readonly BridgeMorphSample<TNodeId>[] {
    if (!this.transition) return this.morphClip ? [{ clip: this.morphClip, time: this.playhead, wrapMode: this.wrapMode, weight: 1 }] : [];
    const progress = this.transition.elapsed / this.transition.duration, samples: BridgeMorphSample<TNodeId>[] = [];
    if (this.transition.fromMorphClip) samples.push({ clip: this.transition.fromMorphClip, time: this.transition.fromTime,
      wrapMode: this.transition.fromWrapMode, weight: 1 - progress });
    if (this.morphClip) samples.push({ clip: this.morphClip, time: this.playhead, wrapMode: this.wrapMode, weight: progress });
    return samples;
  }

  private morphPose(): BridgeMorphPose | undefined {
    if (!this.transition?.fromMorphPose) return undefined;
    return { values: this.transition.fromMorphPose, weight: 1 - this.transition.elapsed / this.transition.duration };
  }

  private captureMorphPose(): readonly Float32Array<ArrayBuffer>[] {
    return Object.freeze(this.frame.morphWeights.map(({ weights }) => new Float32Array(weights.values)));
  }

  private startCurrentTransformLayer(): void {
    if (!this.transformClip) return;
    this.activeLayerId = this.layerId();
    this.mixer.play({ id: this.activeLayerId, clipId: this.transformClip.id, time: this.playhead, timeScale: 0, wrapMode: this.wrapMode });
  }

  private completeTransition(): void {
    this.activeLayerId = this.transition!.targetLayerId;
    if (this.activeLayerId) this.mixer.setTimeScale(this.activeLayerId, 0);
    this.transition = null;
    this.finished = terminal(this.playhead, this.duration(), this.timeScale, this.playbackMode);
  }

  private clearTransformLayers(): void {
    if (this.activeLayerId) this.mixer.stop(this.activeLayerId);
    if (this.transition?.targetLayerId) this.mixer.stop(this.transition.targetLayerId);
    this.activeLayerId = null; this.transition = null;
  }

  private layerId(): string { const id = `${TRANSFORM_LAYER_PREFIX}${this.nextLayerOrdinal}`; this.nextLayerOrdinal += 1; return id; }

  private duration(): number { return this.transformClip?.duration ?? this.morphClip?.duration ?? 0; }
}

function createGraph<TId extends SpatialItemId>(nodes: readonly GltfAnimatedNode<TId>[]): SceneTransformGraph<TId> {
  const graph = new SceneTransformGraph<TId>({ maxNodes: nodes.length });
  graph.transaction((draft) => { for (const node of nodes) draft.create({ id: node.id, parent: node.parent, localTransform: node.localTransform }); });
  return graph;
}

function findClip<TClip extends { readonly id: string }>(clips: readonly TClip[], id: string | null): TClip | null {
  return id === null ? null : clips.find((clip) => clip.id === id) ?? null;
}
function normalizeTime(time: number, duration: number, mode: AnimationWrapMode): number {
  if (duration <= 0) return 0;
  if (mode === "clamp") return Math.min(duration, Math.max(0, time));
  return ((time % duration) + duration) % duration;
}
function terminal(time: number, duration: number, timeScale: number, mode: "loop" | "once"): boolean {
  if (mode === "loop") return false;
  if (duration === 0) return true;
  return timeScale < 0 ? time <= 0 : time >= duration;
}
function assertMatchingDuration<TId extends SpatialItemId>(transforms: readonly AnimationClipInput<TId>[], transformId: string | null,
  morphs: readonly MorphWeightClip<TId>[], morphId: string | null): void {
  const transform = findClip(transforms, transformId), morph = findClip(morphs, morphId);
  if (transform && morph && Math.abs(transform.duration - morph.duration) > 1e-6) {
    throw new GltfRenderAnimationBridgeError("invalid-input", "Synchronized transform and morph clips must have equal duration.");
  }
}
