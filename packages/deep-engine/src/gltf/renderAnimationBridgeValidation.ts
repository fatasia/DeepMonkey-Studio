import { SceneAnimationMixer } from "../animation/SceneAnimationMixer.js";
import type { AnimationClipInput } from "../animation/types.js";
import { sampleMorphWeightTrack } from "../morph/runtime.js";
import type { SpatialItemId } from "../spatial/types.js";
import type { GltfAnimatedNode } from "./animationTypes.js";
import type {
  GltfRenderAnimationBridgeOptions, GltfRenderAnimationSelection, GltfRenderAnimationSources,
  ResolvedGltfRenderAnimationSources,
} from "./renderAnimationBridgeTypes.js";
import { GltfRenderAnimationBridgeError } from "./renderAnimationBridgeTypes.js";

export function resolveBridgeSources<TId extends SpatialItemId>(sources: GltfRenderAnimationSources<TId>): ResolvedGltfRenderAnimationSources<TId> {
  if (!sources || typeof sources !== "object" || Array.isArray(sources)) fail("invalid-input", "Animation bridge sources must be an object.");
  const candidates = [sources.animation, sources.skinning, sources.morph].filter((value) => value !== undefined);
  if (candidates.length === 0) fail("invalid-input", "At least one decoded glTF source is required.");
  const primary = candidates[0]!, nodes = primary.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) fail("invalid-input", "Decoded glTF source must contain nodes.");
  for (const candidate of candidates.slice(1)) {
    if (candidate!.sceneIndex !== primary.sceneIndex) fail("node-mismatch", "Decoded glTF sources select different scenes.");
    assertSameNodes(nodes, candidate!.nodes);
  }
  const transformClips = sourceTransformClips(sources.animation), morphClips = sources.morph?.morphClips ?? [];
  return Object.freeze({ nodes, transformClips, morphClips,
    ...(sources.skinning ? { skinning: sources.skinning } : {}), ...(sources.morph ? { morph: sources.morph } : {}) });
}

export function prepareMixer<TId extends SpatialItemId>(clips: readonly AnimationClipInput<TId>[], nodeCount: number): SceneAnimationMixer<TId> {
  const mixer = new SceneAnimationMixer<TId>({ maxClips: Math.max(1, clips.length), maxAnimatedNodes: Math.max(1, nodeCount), maxLayers: 1,
    maxTracksPerClip: Math.max(1, ...clips.map((clip) => clip.tracks.length)),
    maxKeysPerTrack: Math.max(1, ...clips.flatMap((clip) => clip.tracks.map((track) => track.times.length))) });
  for (const clip of clips) mixer.registerClip(clip);
  return mixer;
}

export function validateBridgeOptions<TId extends SpatialItemId>(options: GltfRenderAnimationBridgeOptions<TId>, nodes: ReadonlySet<TId>): void {
  if (!options || typeof options !== "object" || Array.isArray(options)) fail("invalid-input", "Animation bridge options must be an object.");
  const projection = options.instances;
  if (projection === undefined) return;
  if (!projection || typeof projection !== "object" || !Array.isArray(projection.materials) || !Array.isArray(projection.bindings)) {
    fail("invalid-binding", "Instance projection must contain material and binding arrays.");
  }
  const ids = new Set<string>();
  for (const binding of projection.bindings) {
    if (!binding || typeof binding !== "object" || !nodes.has(binding.nodeId)
      || !nonempty(binding.id) || !nonempty(binding.geometry) || !nonempty(binding.material)) {
      fail("invalid-binding", "Every instance binding must reference a known node and nonempty render ids.");
    }
    if (ids.has(binding.id)) fail("duplicate-binding", `Duplicate render instance id: ${binding.id}.`);
    ids.add(binding.id);
  }
}

export function validateMorphTracks<TId extends SpatialItemId>(source: ResolvedGltfRenderAnimationSources<TId>, nodeIds: ReadonlySet<TId>): void {
  const targetCounts = new Map<TId, number>();
  for (const binding of source.morph?.bindings ?? []) {
    if (!nodeIds.has(binding.nodeId) || !(binding.initialWeights instanceof Float32Array) || binding.initialWeights.length === 0) {
      fail("invalid-binding", "Morph binding must reference a known node and contain initial weights.");
    }
    if (targetCounts.has(binding.nodeId)) fail("duplicate-binding", `Duplicate morph binding for node ${String(binding.nodeId)}.`);
    targetCounts.set(binding.nodeId, binding.initialWeights.length);
  }
  const clipIds = new Set<string>();
  for (const clip of source.morphClips) {
    if (!nonempty(clip.id) || clipIds.has(clip.id)) fail("invalid-input", `Duplicate or empty morph clip id: ${clip.id}.`);
    clipIds.add(clip.id);
    const trackedNodes = new Set<TId>();
    for (const track of clip.tracks) {
      if (trackedNodes.has(track.nodeId)) fail("duplicate-binding", `Morph clip ${clip.id} targets a node more than once.`);
      trackedNodes.add(track.nodeId);
      if (targetCounts.get(track.nodeId) !== track.targetCount) fail("invalid-binding", "Morph track does not match its decoded node binding.");
      sampleMorphWeightTrack(track, 0, { wrapMode: "clamp" }, new Float32Array(track.targetCount));
    }
  }
}

export function resolvedSelection<TId extends SpatialItemId>(source: ResolvedGltfRenderAnimationSources<TId>, input: GltfRenderAnimationSelection = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("invalid-input", "Animation selection must be an object.");
  const transformClipId = selectClip(input.transformClipId, source.transformClips, "transform");
  const morphClipId = selectClip(input.morphClipId, source.morphClips, "morph");
  const wrapMode = input.wrapMode ?? "loop", time = input.time ?? 0, timeScale = input.timeScale ?? 1;
  if (wrapMode !== "loop" && wrapMode !== "clamp") fail("invalid-time", "Animation wrap mode must be loop or clamp.");
  validateTime(time, "Animation time"); validateTimeScale(timeScale);
  if (input.paused !== undefined && typeof input.paused !== "boolean") fail("invalid-time", "Animation paused state must be boolean.");
  return { transformClipId, morphClipId, wrapMode, time, timeScale, paused: input.paused ?? false };
}

export function validateTime(value: number, label = "Animation time"): void {
  if (!Number.isFinite(value) || Math.abs(value) > 1e15) fail("invalid-time", `${label} is invalid.`);
}
export function validateTimeScale(value: number): void {
  if (!Number.isFinite(value) || Math.abs(value) > 1_000_000) fail("invalid-time", "Animation time scale is invalid.");
}

function sourceTransformClips<TId extends SpatialItemId>(source: GltfRenderAnimationSources<TId>["animation"]): readonly AnimationClipInput<TId>[] {
  if (!source) return [];
  const transformClips = "transformClips" in source ? source.transformClips : undefined;
  if (source.clips !== undefined && transformClips !== undefined) fail("invalid-input", "Animation source cannot expose both clip collections.");
  const clips = transformClips ?? source.clips ?? [];
  if (!Array.isArray(clips)) fail("invalid-input", "Animation clips must be an array.");
  return clips;
}

function assertSameNodes<TId extends SpatialItemId>(expected: readonly GltfAnimatedNode<TId>[], actual: readonly GltfAnimatedNode<TId>[]): void {
  if (actual.length !== expected.length) fail("node-mismatch", "Decoded glTF node collections have different lengths.");
  for (let index = 0; index < expected.length; index += 1) {
    const left = expected[index]!, right = actual[index]!;
    if (left.sourceNodeIndex !== right.sourceNodeIndex || !Object.is(left.id, right.id) || !Object.is(left.parent, right.parent)) {
      fail("node-mismatch", `Decoded glTF node identity differs at index ${index}.`);
    }
    if (!sameTransform(left.localTransform, right.localTransform)) fail("node-mismatch", `Decoded glTF node transform differs at index ${index}.`);
  }
}

function sameTransform(left: GltfAnimatedNode<SpatialItemId>["localTransform"], right: GltfAnimatedNode<SpatialItemId>["localTransform"]): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "matrix" && right.kind === "matrix") return sameArray(left.matrix, right.matrix);
  if (left.kind === "trs" && right.kind === "trs") return sameArray(left.translation, right.translation)
    && sameArray(left.rotation, right.rotation) && sameArray(left.scale, right.scale);
  return false;
}
function sameArray(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function selectClip<TClip extends { readonly id: string }>(requested: string | null | undefined, clips: readonly TClip[], label: string): string | null {
  if (requested === null || requested === undefined && clips.length === 0) return null;
  const id = requested ?? clips[0]!.id;
  if (!clips.some((clip) => clip.id === id)) fail("missing-clip", `Selected ${label} clip does not exist: ${id}.`);
  return id;
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function fail(code: ConstructorParameters<typeof GltfRenderAnimationBridgeError>[0], message: string): never {
  throw new GltfRenderAnimationBridgeError(code, message);
}
