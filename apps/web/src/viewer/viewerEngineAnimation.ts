import * as THREE from "three";
import type { SceneModelAnimationPlaybackState } from "@bim-studio/contracts";

export type AnimationControl = {
  action: "play" | "pause" | "stop" | "seek";
  clipId?: string;
  time?: number;
};

export type AnimationPlayback = {
  clipId?: string;
  time: number;
  duration: number;
  playing: boolean;
  autoplay: boolean;
  loopMode: "once" | "loop";
};

export type AnimationContext = {
  mixers: Map<string, THREE.AnimationMixer>;
  animationClips: Map<string, THREE.AnimationClip[]>;
  animationClipSelection: Map<string, string>;
  animationEnabledIds: Set<string>;
  modelAnimationPlaybackStates: Map<string, SceneModelAnimationPlaybackState>;
  models: Map<string, { id: string }>;
  onModelChange?: (model: unknown) => void;
  dispatchObjectLifecycle: (trigger: "load" | "animationStart" | "animationEnd", modelId: string) => void;
  applyModelAnimationLoopPolicy: (id: string, clips?: THREE.AnimationClip[]) => void;
};

export function hasAnimation(context: AnimationContext, id: string): boolean {
  return context.mixers.has(id);
}

export function listAnimationClips(context: AnimationContext, id: string): Array<{ id: string; name: string; duration: number }> {
  return (context.animationClips.get(id) ?? []).map((clip) => ({ id: clip.name || clip.uuid, name: clip.name || clip.uuid, duration: clip.duration }));
}

export function getModelAnimationPlaybackState(context: AnimationContext, id: string): SceneModelAnimationPlaybackState {
  return structuredClone(context.modelAnimationPlaybackStates.get(id) ?? { autoplay: true, loopMode: "loop" });
}

export function getAnimationPlayback(context: AnimationContext, id: string): AnimationPlayback | undefined {
  const mixer = context.mixers.get(id);
  const clips = context.animationClips.get(id) ?? [];
  if (!mixer || clips.length === 0) return undefined;
  const selectedId = context.animationClipSelection.get(id);
  const selected = selectedId ? clips.find((clip) => (clip.name || clip.uuid) === selectedId) : clips[0];
  const duration = Math.max(0, selected?.duration ?? Math.max(...clips.map((clip) => clip.duration)));
  const policy = getModelAnimationPlaybackState(context, id);
  const time = duration > 0 ? (policy.loopMode === "loop" ? mixer.time % duration : Math.min(mixer.time, duration)) : mixer.time;
  return {
    ...(selected ? { clipId: selected.name || selected.uuid } : {}),
    time,
    duration,
    playing: context.animationEnabledIds.has(id) && mixer.timeScale !== 0,
    ...policy,
  };
}

export function setModelAnimationPlaybackState(context: AnimationContext, id: string, state: SceneModelAnimationPlaybackState): void {
  const next: SceneModelAnimationPlaybackState = { autoplay: Boolean(state.autoplay), loopMode: state.loopMode === "once" ? "once" : "loop" };
  context.modelAnimationPlaybackStates.set(id, next);
  context.applyModelAnimationLoopPolicy(id);
  const model = context.models.get(id);
  if (model) context.onModelChange?.(model);
}

export function applyModelAnimationLoopPolicy(context: AnimationContext, id: string, clips = context.animationClips.get(id) ?? []): void {
  const mixer = context.mixers.get(id);
  if (!mixer) return;
  const policy = getModelAnimationPlaybackState(context, id);
  for (const clip of clips) {
    const action = mixer.clipAction(clip);
    action.clampWhenFinished = policy.loopMode === "once";
    action.setLoop(policy.loopMode === "once" ? THREE.LoopOnce : THREE.LoopRepeat, policy.loopMode === "once" ? 1 : Infinity);
  }
}

export function restartModelAnimationActions(context: AnimationContext, id: string): void {
  const mixer = context.mixers.get(id);
  const clips = context.animationClips.get(id) ?? [];
  if (!mixer) return;
  const activeId = context.animationClipSelection.get(id);
  const active = activeId ? clips.filter((clip) => (clip.name || clip.uuid) === activeId) : clips;
  context.applyModelAnimationLoopPolicy(id, active);
  active.forEach((clip) => mixer.clipAction(clip).reset().play());
}

export function updateCompletedModelAnimations(context: AnimationContext): void {
  for (const id of [...context.animationEnabledIds]) {
    if (getModelAnimationPlaybackState(context, id).loopMode !== "once") continue;
    const mixer = context.mixers.get(id);
    const clips = context.animationClips.get(id) ?? [];
    const selectedId = context.animationClipSelection.get(id);
    const active = selectedId ? clips.filter((clip) => (clip.name || clip.uuid) === selectedId) : clips;
    if (!mixer || active.length === 0 || active.some((clip) => mixer.existingAction(clip)?.isRunning())) continue;
    context.animationEnabledIds.delete(id);
    const model = context.models.get(id);
    if (model) context.onModelChange?.(model);
    queueMicrotask(() => context.dispatchObjectLifecycle("animationEnd", id));
  }
}

export function controlAnimation(context: AnimationContext, id: string, control: AnimationControl): boolean {
  const mixer = context.mixers.get(id);
  const clips = context.animationClips.get(id) ?? [];
  if (!mixer || clips.length === 0) return false;
  const selected = control.clipId ? clips.find((clip) => clip.name === control.clipId || clip.uuid === control.clipId) : undefined;
  if (control.clipId && !selected) return false;
  if (selected) context.animationClipSelection.set(id, selected.name || selected.uuid);
  const activeId = context.animationClipSelection.get(id);
  const active = activeId ? clips.find((clip) => (clip.name || clip.uuid) === activeId) : undefined;
  if (control.action === "play") {
    mixer.stopAllAction();
    context.applyModelAnimationLoopPolicy(id, active ? [active] : clips);
    (active ? [active] : clips).forEach((clip) => mixer.clipAction(clip).reset().play());
    mixer.timeScale = 1;
    context.animationEnabledIds.add(id);
  } else if (control.action === "pause") {
    mixer.timeScale = 0;
    context.animationEnabledIds.delete(id);
  } else if (control.action === "stop") {
    mixer.stopAllAction();
    mixer.setTime(0);
    mixer.timeScale = 0;
    context.animationEnabledIds.delete(id);
  } else {
    if (control.time === undefined || !Number.isFinite(control.time) || control.time < 0) return false;
    mixer.setTime(control.time);
  }
  const model = context.models.get(id);
  if (model) context.onModelChange?.(model);
  return true;
}

export function transitionAnimationClip(context: AnimationContext, id: string, fromClipId: string, toClipId: string, durationSeconds: number): boolean {
  const mixer = context.mixers.get(id);
  const clips = context.animationClips.get(id) ?? [];
  const from = clips.find((clip) => clip.name === fromClipId || clip.uuid === fromClipId);
  const to = clips.find((clip) => clip.name === toClipId || clip.uuid === toClipId);
  if (!mixer || !from || !to || !Number.isFinite(durationSeconds) || durationSeconds < 0) return false;
  const fromAction = mixer.clipAction(from);
  const toAction = mixer.clipAction(to);
  context.applyModelAnimationLoopPolicy(id, [to]);
  toAction.reset().play();
  if (durationSeconds === 0) {
    fromAction.stop();
    toAction.enabled = true;
    toAction.setEffectiveWeight(1);
  } else {
    fromAction.crossFadeTo(toAction, durationSeconds, false);
  }
  mixer.timeScale = 1;
  context.animationClipSelection.set(id, to.name || to.uuid);
  context.animationEnabledIds.add(id);
  const model = context.models.get(id);
  if (model) context.onModelChange?.(model);
  return true;
}
