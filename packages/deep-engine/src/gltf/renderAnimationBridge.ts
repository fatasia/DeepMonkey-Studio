import { SceneTransformGraph } from "../scene/SceneTransformGraph.js";
import type { SpatialItemId } from "../spatial/types.js";
import type { AnimationClipInput, AnimationWrapMode } from "../animation/types.js";
import type { MorphWeightClip } from "../morph/types.js";
import type { GltfAnimatedNode } from "./animationTypes.js";
import {
  commitBankState, createBridgeBank, createBridgeLayout, fillBridgeBank, initializeBankState, sameBridgeBank,
  type BridgeBank, type BridgeLayout,
} from "./renderAnimationBridgeBuffers.js";
import type {
  GltfRenderAnimationBridgeOptions, GltfRenderAnimationFrame, GltfRenderAnimationSelection, GltfRenderAnimationSources,
} from "./renderAnimationBridgeTypes.js";
import { GltfRenderAnimationBridgeError } from "./renderAnimationBridgeTypes.js";
import {
  prepareMixer, resolvedSelection, resolveBridgeSources, validateBridgeOptions, validateMorphTracks, validateTime, validateTimeScale,
} from "./renderAnimationBridgeValidation.js";

const TRANSFORM_LAYER_ID = "__deep_gltf_render_bridge__";

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
  private playhead = 0;
  private timeScale = 1;
  private paused = false;

  constructor(sources: GltfRenderAnimationSources<TNodeId>, options: GltfRenderAnimationBridgeOptions<TNodeId> = {}) {
    this.source = resolveBridgeSources(sources);
    const nodeIds = new Set(this.source.nodes.map(({ id }) => id));
    validateBridgeOptions(options, nodeIds); validateMorphTracks(this.source, nodeIds);
    this.graph = createGraph(this.source.nodes);
    this.mixer = prepareMixer(this.source.transformClips, this.source.nodes.length);
    this.layout = createBridgeLayout(this.source);
    this.banks = [createBridgeBank(this.layout, options), createBridgeBank(this.layout, options)];
    this.select(options.selection);
    this.applyTransformPose();
    fillBridgeBank(this.banks[0], this.layout, this.graph, this.morphClip, this.playhead, this.wrapMode);
    fillBridgeBank(this.banks[1], this.layout, this.graph, this.morphClip, this.playhead, this.wrapMode);
    initializeBankState(this.banks[0], 0, this.playhead, this.paused);
    initializeBankState(this.banks[1], 0, this.playhead, this.paused);
  }

  get frame(): GltfRenderAnimationFrame<TNodeId> { return this.banks[this.activeBank].frame; }
  get revision(): number { return this.stateRevision; }
  get time(): number { return this.playhead; }
  get isPaused(): boolean { return this.paused; }

  /** Selects synchronized clips and applies their requested starting pose immediately. */
  play(selection: GltfRenderAnimationSelection = {}): GltfRenderAnimationFrame<TNodeId> {
    const resolved = resolvedSelection(this.source, selection);
    assertMatchingDuration(this.source.transformClips, resolved.transformClipId, this.source.morphClips, resolved.morphClipId);
    this.resetGraphPose();
    this.mixer.stop(TRANSFORM_LAYER_ID);
    this.assignSelection(resolved);
    if (this.transformClip) this.mixer.play({ id: TRANSFORM_LAYER_ID, clipId: this.transformClip.id,
      time: this.playhead, timeScale: 0, wrapMode: this.wrapMode });
    return this.renderCurrentPose();
  }

  pause(): void { this.paused = true; this.setCurrentFrameState(); }
  resume(): void { this.paused = false; this.setCurrentFrameState(); }
  setTimeScale(value: number): void { validateTimeScale(value); this.timeScale = value; }

  seek(time: number): GltfRenderAnimationFrame<TNodeId> {
    validateTime(time); this.playhead = normalizeTime(time, this.duration(), this.wrapMode);
    return this.renderCurrentPose();
  }

  update(deltaSeconds: number): GltfRenderAnimationFrame<TNodeId> {
    validateTime(deltaSeconds, "Animation frame delta");
    if (!this.paused) this.playhead = normalizeTime(this.playhead + deltaSeconds * this.timeScale, this.duration(), this.wrapMode);
    return this.renderCurrentPose();
  }

  private select(selection: GltfRenderAnimationSelection | undefined): void {
    const resolved = resolvedSelection(this.source, selection);
    assertMatchingDuration(this.source.transformClips, resolved.transformClipId, this.source.morphClips, resolved.morphClipId);
    this.assignSelection(resolved);
    if (this.transformClip) this.mixer.play({ id: TRANSFORM_LAYER_ID, clipId: this.transformClip.id,
      time: this.playhead, timeScale: 0, wrapMode: this.wrapMode });
  }

  private assignSelection(selection: { transformClipId: string | null; morphClipId: string | null; wrapMode: AnimationWrapMode;
    time: number; timeScale: number; paused: boolean }): void {
    this.transformClip = findClip(this.source.transformClips, selection.transformClipId);
    this.morphClip = findClip(this.source.morphClips, selection.morphClipId);
    this.wrapMode = selection.wrapMode; this.timeScale = selection.timeScale; this.paused = selection.paused;
    this.playhead = normalizeTime(selection.time, this.duration(), this.wrapMode);
  }

  private renderCurrentPose(): GltfRenderAnimationFrame<TNodeId> {
    this.applyTransformPose();
    const next = this.activeBank === 0 ? 1 : 0;
    fillBridgeBank(this.banks[next], this.layout, this.graph, this.morphClip, this.playhead, this.wrapMode);
    if (!sameBridgeBank(this.banks[this.activeBank], this.banks[next])) {
      this.stateRevision += 1; commitBankState(this.banks[this.activeBank], this.banks[next], this.stateRevision, this.playhead, this.paused);
      this.activeBank = next;
    }
    this.setCurrentFrameState();
    return this.banks[this.activeBank].frame;
  }

  private applyTransformPose(): void {
    if (!this.transformClip) return;
    this.mixer.seek(TRANSFORM_LAYER_ID, this.playhead);
    this.mixer.sampleAndApply(this.graph, 0);
  }

  private resetGraphPose(): void {
    this.graph.transaction((draft) => { for (const node of this.source.nodes) draft.update(node.id, { localTransform: node.localTransform }); });
  }

  private setCurrentFrameState(): void {
    const frame = this.banks[this.activeBank].frame;
    frame.revision = this.stateRevision; frame.time = this.playhead; frame.paused = this.paused;
  }

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
function assertMatchingDuration<TId extends SpatialItemId>(transforms: readonly AnimationClipInput<TId>[], transformId: string | null,
  morphs: readonly MorphWeightClip<TId>[], morphId: string | null): void {
  const transform = findClip(transforms, transformId), morph = findClip(morphs, morphId);
  if (transform && morph && Math.abs(transform.duration - morph.duration) > 1e-6) {
    throw new GltfRenderAnimationBridgeError("invalid-input", "Synchronized transform and morph clips must have equal duration.");
  }
}
