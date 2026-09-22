import {
  validateDynamicSceneRuntime,
  type DeepRuntimePackage,
  type DynamicAnimationValue,
  type DynamicSceneRuntime,
} from "@bim-studio/deep-engine/runtime-package";

export interface DynamicRuntimeTransform {
  readonly translation?: readonly [number, number, number];
  /** Quaternion in the package's x/y/z/w order. */
  readonly rotationQuaternion?: readonly [number, number, number, number];
  readonly scale?: readonly [number, number, number];
}

export interface DynamicRuntimeFrame {
  readonly timeMs: number;
  readonly transforms: Readonly<Record<string, DynamicRuntimeTransform>>;
  readonly camera?: { readonly position: readonly [number, number, number]; readonly target: readonly [number, number, number] };
  readonly replayEvents: readonly { readonly revision: number; readonly timeMs: number; readonly payload: unknown }[];
  readonly interaction?: DynamicSceneRuntime["interaction"];
}

export interface DynamicRuntimeFrameSink {
  applyTransform(targetId: string, transform: DynamicRuntimeTransform): void;
  applyCamera?(camera: NonNullable<DynamicRuntimeFrame["camera"]>): void;
  applyReplayEvent?(channel: string, event: { readonly revision: number; readonly timeMs: number; readonly payload: unknown }): void;
  applyInteraction?(interaction: NonNullable<DynamicSceneRuntime["interaction"]>): void;
}

function lerp(a: number, b: number, amount: number): number { return a + (b - a) * amount; }
export function dynamicTransitionAmount(amount: number, transition: "linear" | "smooth" | "ease-in" | "ease-out" | "step" = "linear"): number {
  const t = Math.max(0, Math.min(1, amount));
  switch (transition) {
    case "step": return 0;
    case "ease-in": return t * t;
    case "ease-out": return 1 - (1 - t) * (1 - t);
    case "smooth": return t * t * (3 - 2 * t);
    default: return t;
  }
}
function sampleTrack(track: NonNullable<DynamicSceneRuntime["animation"]>["tracks"][number], timeMs: number): DynamicAnimationValue {
  const frames = track.keyframes;
  if (timeMs <= frames[0]!.timeMs) return frames[0]!.value;
  if (timeMs >= frames.at(-1)!.timeMs) return frames.at(-1)!.value;
  for (let index = 1; index < frames.length; index += 1) {
    const end = frames[index]!;
    if (timeMs > end.timeMs) continue;
    const start = frames[index - 1]!;
    const amount = (timeMs - start.timeMs) / Math.max(end.timeMs - start.timeMs, 1);
    const eased = dynamicTransitionAmount(amount, end.transition);
    return start.value.map((value, component) => lerp(value, end.value[component]!, eased)) as unknown as DynamicAnimationValue;
  }
  return frames.at(-1)!.value;
}

export interface CanonicalDynamicFrameSample { readonly targetId: string; readonly property: string; readonly value: DynamicAnimationValue }

function formatComponent(value: number): string {
  // -0 必须归一为 +0,否则跨端(Native Rust {:.6})会产出 "-0.000000" 分叉。
  return (value === 0 ? 0 : value).toFixed(6);
}

/** Canonical, byte-identical across TS/Rust consumers: sorted tracks, fixed 6-decimal
 * components, integer clock. This string (not its hash) is the cross-end determinism
 * contract; drivers hash it with one shared SHA-256 implementation. */
export function canonicalDynamicRuntimeFrame(
  runtimePackage: DeepRuntimePackage,
  timeMs: number,
): { readonly timeMs: number; readonly canonical: string; readonly tracks: readonly CanonicalDynamicFrameSample[]; readonly replayRevisions: readonly number[] } {
  const id = runtimePackage.entrypoints.dynamicRuntime;
  if (!id) throw new Error("Runtime package has no dynamicRuntime entrypoint.");
  const parsed = validateDynamicSceneRuntime(runtimePackage.payloads[id]);
  if (!parsed.valid) throw new Error(`Invalid dynamicRuntime payload: ${parsed.issues[0]?.message ?? "unknown error"}`);
  const runtime = parsed.value;
  const clamped = Math.max(0, Math.min(runtime.animation?.durationMs ?? 0, Math.round(timeMs)));
  const tracks = (runtime.animation?.tracks ?? []).map(track => ({
    targetId: track.targetId, property: track.property, value: sampleTrack(track, clamped),
  })).sort((a, b) => a.targetId === b.targetId ? (a.property < b.property ? -1 : a.property > b.property ? 1 : 0) : a.targetId < b.targetId ? -1 : 1);
  const revisions = (runtime.dataReplay?.events ?? []).filter(event => event.timeMs <= clamped).map(event => event.revision);
  const canonical = `dynamic-frame-v1|t=${clamped}|events=${revisions.join(",")}|tracks=${
    tracks.map(track => `${track.targetId}>${track.property}=${track.value.map(value => formatComponent(value)).join(",")}`).join(";")}`;
  return { timeMs: clamped, canonical, tracks, replayRevisions: revisions };
}

/** Read the v7 package entrypoint, sample its tracks, and return an apply-ready frame. */
export function sampleDynamicRuntimePackage(runtimePackage: DeepRuntimePackage, timeMs: number): DynamicRuntimeFrame {
  const id = runtimePackage.entrypoints.dynamicRuntime;
  if (!id) throw new Error("Runtime package has no dynamicRuntime entrypoint.");
  const parsed = validateDynamicSceneRuntime(runtimePackage.payloads[id]);
  if (!parsed.valid) throw new Error(`Invalid dynamicRuntime payload: ${parsed.issues[0]?.message ?? "unknown error"}`);
  const runtime = parsed.value;
  const clamped = Math.max(0, Math.min(runtime.animation?.durationMs ?? 0, Math.round(timeMs)));
  const transforms: Record<string, DynamicRuntimeTransform> = {};
  let cameraPosition: readonly [number, number, number] | undefined;
  let cameraTarget: readonly [number, number, number] | undefined;
  for (const track of runtime.animation?.tracks ?? []) {
    const value = sampleTrack(track, clamped);
    if (track.property === "camera-position") { cameraPosition = [value[0], value[1], value[2]]; continue; }
    if (track.property === "camera-target") { cameraTarget = [value[0], value[1], value[2]]; continue; }
    const current = transforms[track.targetId] ?? {};
    transforms[track.targetId] = track.property === "translation"
      ? { ...current, translation: [value[0], value[1], value[2]] }
      : track.property === "scale"
        ? { ...current, scale: [value[0], value[1], value[2]] }
        : (() => {
          const length = Math.hypot(value[3], value[4], value[5], value[6]) || 1;
          return { ...current, rotationQuaternion: [value[3] / length, value[4] / length, value[5] / length, value[6] / length] as const };
        })();
  }
  return {
    timeMs: clamped,
    transforms,
    ...(cameraPosition && cameraTarget ? { camera: { position: cameraPosition, target: cameraTarget } } : {}),
    replayEvents: (runtime.dataReplay?.events ?? []).filter((event) => event.timeMs <= clamped),
    ...(runtime.interaction ? { interaction: runtime.interaction } : {}),
  };
}

/** Apply one sampled package frame to the host's scene/data consumers. */
export function applyDynamicRuntimeFrame(runtimePackage: DeepRuntimePackage, timeMs: number, sink: DynamicRuntimeFrameSink): DynamicRuntimeFrame {
  const frame = sampleDynamicRuntimePackage(runtimePackage, timeMs);
  for (const [targetId, transform] of Object.entries(frame.transforms)) sink.applyTransform(targetId, transform);
  if (frame.camera && sink.applyCamera) sink.applyCamera(frame.camera);
  const id = runtimePackage.entrypoints.dynamicRuntime!;
  const parsed = validateDynamicSceneRuntime(runtimePackage.payloads[id]);
  if (parsed.valid && frame.replayEvents.length && sink.applyReplayEvent) {
    for (const event of frame.replayEvents) sink.applyReplayEvent(parsed.value.dataReplay!.channel, event);
  }
  if (frame.interaction && sink.applyInteraction) sink.applyInteraction(frame.interaction);
  return frame;
}
