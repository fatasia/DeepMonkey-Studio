import { describe, expect, it, vi } from "vitest";
import type { SceneAnimationStateMachineState } from "@bim-studio/contracts";
import type { ViewerEngine } from "./ViewerEngine";
import { createSceneAnimationStateMachine, evaluateSceneAnimationStateConditions, transitionSceneAnimationState } from "./sceneAnimationStateMachineRuntime";

const configuration: SceneAnimationStateMachineState = {
  enabled: true,
  initialStateId: "idle",
  activeStateId: "idle",
  transitionDuration: 0.35,
  states: [
    { id: "idle", name: "Idle", modelId: "robot", clipId: "idle-clip", loop: true },
    { id: "work", name: "Work", modelId: "robot", clipId: "work-clip", loop: true },
  ],
  parameters: { advance: false },
  transitions: [{ id: "idle-work", fromStateId: "idle", toStateId: "work", parameter: "advance", equals: true }],
};

describe("scene animation state machine product runtime", () => {
  it("builds a persistable cyclic condition graph from imported clips", () => {
    const result = createSceneAnimationStateMachine("robot", [{ id: "idle", name: "Idle" }, { id: "work", name: "Work" }]);
    expect(result).toMatchObject({ initialStateId: "robot:idle", activeStateId: "robot:idle", parameters: { advance: false } });
    expect(result.transitions).toEqual([
      { id: "robot:idle:advance", fromStateId: "robot:idle", toStateId: "robot:work", parameter: "advance", equals: true },
      { id: "robot:work:advance", fromStateId: "robot:work", toStateId: "robot:idle", parameter: "advance", equals: true },
    ]);
    expect(() => createSceneAnimationStateMachine("robot", [])).toThrow("至少需要一个动画片段");
  });
  it("plays the active clip and cross-fades to the requested persisted state", () => {
    const controlAnimation = vi.fn(() => true);
    const transitionAnimationClip = vi.fn(() => true);
    const engine = { controlAnimation, transitionAnimationClip } as unknown as ViewerEngine;
    expect(transitionSceneAnimationState(engine, configuration, "work")).toEqual({ changed: true, activeStateId: "work" });
    expect(controlAnimation).toHaveBeenCalledWith("robot", { action: "play", clipId: "idle-clip" });
    expect(transitionAnimationClip).toHaveBeenCalledWith("robot", "idle-clip", "work-clip", 0.35);
  });

  it("fails closed for disabled, stale, cross-object, or rejected playback states", () => {
    const engine = { controlAnimation: vi.fn(() => false), transitionAnimationClip: vi.fn(() => false) } as unknown as ViewerEngine;
    expect(transitionSceneAnimationState(engine, { ...configuration, enabled: false }, "work").changed).toBe(false);
    expect(transitionSceneAnimationState(engine, configuration, "missing").changed).toBe(false);
    expect(transitionSceneAnimationState(engine, { ...configuration, states: [configuration.states[0]!, { ...configuration.states[1]!, modelId: "other" }] }, "work").changed).toBe(false);
    expect(transitionSceneAnimationState(engine, configuration, "work").error).toContain("动画片段不可用");
  });

  it("persists parameters and consumes a matching conditional edge through the viewer", () => {
    const controlAnimation = vi.fn(() => true);
    const transitionAnimationClip = vi.fn(() => true);
    const engine = { controlAnimation, transitionAnimationClip } as unknown as ViewerEngine;
    expect(evaluateSceneAnimationStateConditions(engine, configuration).error).toContain("未命中");
    const result = evaluateSceneAnimationStateConditions(engine, { ...configuration, parameters: { advance: true } });
    expect(result).toEqual({ changed: true, activeStateId: "work" });
    expect(transitionAnimationClip).toHaveBeenLastCalledWith("robot", "idle-clip", "work-clip", 0.35);
  });
});
