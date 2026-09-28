import { describe, expect, it } from "vitest";
import type { SceneAnimationStateMachineState } from "@bim-studio/contracts";
import { compileSceneAnimationController } from "./compileSceneAnimationController";

const stateMachine: SceneAnimationStateMachineState = {
  enabled: true,
  initialStateId: "robot:idle",
  activeStateId: "robot:idle",
  transitionDuration: 0.25,
  states: [{ id: "robot:idle", name: "Idle", modelId: "robot", clipId: "Idle", loop: true }],
  parameters: { advance: false },
  transitions: [],
};

describe("scene animation controller compilation", () => {
  it("passes product clip event markers through to the runtime package ABI", () => {
    // T14：事件标记随 animationController 一并下译；Rust 侧
    // `runtime_package::dynamic_scene` 按同一 camelCase 字段 fail-closed 解析。
    const compiled = compileSceneAnimationController({
      id: "scene.dynamic",
      revision: 1,
      stateMachine: { ...stateMachine, events: [{ clipId: "Idle", eventId: "footstep", time: 0.25 }] },
    });
    expect(compiled?.animationController?.events).toEqual([
      { clipId: "Idle", eventId: "footstep", time: 0.25 },
    ]);
  });

  it("omits the events field entirely for controllers without markers", () => {
    const compiled = compileSceneAnimationController({ id: "scene.dynamic", revision: 1, stateMachine });
    expect(compiled?.animationController).toBeTruthy();
    expect(Object.hasOwn(compiled?.animationController ?? {}, "events")).toBe(false);
    // 空数组与缺省同语义：不写字段，旧包字节逐位不变。
    const empty = compileSceneAnimationController({
      id: "scene.dynamic",
      revision: 1,
      stateMachine: { ...stateMachine, events: [] },
    });
    expect(Object.hasOwn(empty?.animationController ?? {}, "events")).toBe(false);
  });

  it("rejects invalid marker payloads through the shared runtime validation", () => {
    expect(() => compileSceneAnimationController({
      id: "scene.dynamic",
      revision: 1,
      stateMachine: { ...stateMachine, events: [{ clipId: "Idle", eventId: "dupe", time: 0.1 }, { clipId: "Idle", eventId: "dupe", time: 0.2 }] },
    })).toThrow();
    expect(() => compileSceneAnimationController({
      id: "scene.dynamic",
      revision: 1,
      stateMachine: { ...stateMachine, events: [{ clipId: "Idle", eventId: "negative", time: -1 }] },
    })).toThrow();
  });
});
