import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { ViewerEngineInteraction } from "./viewerEngineInteraction";

describe("ViewerEngine animation clip transitions", () => {
  it("cross-fades real Three actions and publishes the target clip selection", () => {
    const root = new THREE.Group();
    const mixer = new THREE.AnimationMixer(root);
    const idle = new THREE.AnimationClip("idle", 1, []);
    const work = new THREE.AnimationClip("work", 1, []);
    const fromAction = mixer.clipAction(idle).play();
    const crossFadeTo = vi.spyOn(fromAction, "crossFadeTo");
    const animationClipSelection = new Map<string, string>();
    const animationEnabledIds = new Set<string>();
    const onModelChange = vi.fn();
    const context = {
      mixers: new Map([["robot", mixer]]),
      animationClips: new Map([["robot", [idle, work]]]),
      animationClipSelection,
      animationEnabledIds,
      applyModelAnimationLoopPolicy: vi.fn(),
      models: new Map([["robot", { id: "robot" }]]),
      onModelChange,
    };
    const transition = ViewerEngineInteraction.prototype.transitionAnimationClip as unknown as
      (this: typeof context, id: string, from: string, to: string, duration: number) => boolean;

    expect(transition.call(context, "robot", "idle", "work", 0.4)).toBe(true);
    expect(crossFadeTo).toHaveBeenCalledWith(mixer.clipAction(work), 0.4, false);
    expect(animationClipSelection.get("robot")).toBe("work");
    expect(animationEnabledIds.has("robot")).toBe(true);
    expect(onModelChange).toHaveBeenCalled();
  });

  it("rejects missing clips and invalid transition durations without mutating playback", () => {
    const mixer = new THREE.AnimationMixer(new THREE.Group());
    const idle = new THREE.AnimationClip("idle", 1, []);
    const context = {
      mixers: new Map([["robot", mixer]]), animationClips: new Map([["robot", [idle]]]),
      animationClipSelection: new Map(), animationEnabledIds: new Set(), applyModelAnimationLoopPolicy: vi.fn(), models: new Map(),
    };
    const transition = ViewerEngineInteraction.prototype.transitionAnimationClip as unknown as
      (this: typeof context, id: string, from: string, to: string, duration: number) => boolean;
    expect(transition.call(context, "robot", "idle", "missing", 0.2)).toBe(false);
    expect(transition.call(context, "robot", "idle", "idle", -1)).toBe(false);
    expect(context.applyModelAnimationLoopPolicy).not.toHaveBeenCalled();
  });
});
