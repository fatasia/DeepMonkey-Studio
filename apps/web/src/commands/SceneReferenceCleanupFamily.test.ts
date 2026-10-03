import { describe, expect, it } from "vitest";
import type { ModelKeyframe, SceneAnimationState, SimulationEntityState } from "@bim-studio/contracts";
import { SceneReferenceRegistry, SceneReferenceResolutionError, resolveSceneReferenceIntegrity } from "./SceneReferenceCleanupPort";

const frame = (modelId: string, clipId: string): ModelKeyframe => ({
  id: `frame-${modelId}`, time: 0, modelId, animation: { clipId, time: 0 },
  transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
});
const animation = (sameClip = false): SceneAnimationState => ({
  duration: 1, loop: false, camera: [], models: [frame("victim", "walk"), frame("keeper", sameClip ? "walk" : "idle")],
  stateMachine: { enabled: true, initialStateId: "keep", activeStateId: "keep", transitionDuration: 0.1,
    states: [{ id: "keep", name: "keeper", modelId: "keeper", clipId: "idle", loop: true }],
    events: [{ clipId: "walk", eventId: "step", time: 0.2 }] },
});

function registry(state: SceneAnimationState) {
  return new SceneReferenceRegistry({ sceneId: "scene", containers: { selectionSets: [], rootLayerOrder: [], animation: state } });
}

describe("reference consumption family", () => {
  it("rejects an unknown simulation kind even when it includes targetModelId", () => {
    const malformed = { id: "bad", kind: "unknown", targetModelId: "keeper" } as unknown as SimulationEntityState;
    expect(() => resolveSceneReferenceIntegrity({ simulationEntities: [malformed], isKnownObject: () => true })).toThrow(SceneReferenceResolutionError);
    const refs = new SceneReferenceRegistry({ sceneId: "scene", containers: { selectionSets: [{ id: "set", name: "set", objectIds: ["victim"] }], rootLayerOrder: [], simulationEntities: [malformed] } });
    const before = refs.snapshotReferences();
    expect(() => refs.pruneDeletedObjectReferences("victim")).toThrow(SceneReferenceResolutionError);
    expect(refs.snapshotReferences()).toEqual(before);
  });

  it("removes events referenced only by deleted timeline frames even when no machine state is deleted", () => {
    const refs = registry(animation());
    const result = refs.pruneDeletedObjectReferences("victim");
    expect(result.animationStatesConsumed).toEqual([]);
    expect(result.animationEventsRemoved).toBe(1);
    expect(refs.state.animation!.stateMachine!.events).toEqual([]);
    expect(() => resolveSceneReferenceIntegrity({ animation: refs.state.animation!, isKnownObject: id => id === "keeper" })).not.toThrow();
  });

  it("preserves an event when the same clip is still referenced by another object", () => {
    const state = animation(true);
    state.stateMachine!.states.unshift({ id: "victim-state", name: "victim", modelId: "victim", clipId: "walk", loop: true });
    const refs = registry(state);
    const result = refs.pruneDeletedObjectReferences("victim");
    expect(result.animationEventsRemoved).toBe(0);
    expect(refs.state.animation!.stateMachine!.events).toEqual([{ clipId: "walk", eventId: "step", time: 0.2 }]);
    expect(() => resolveSceneReferenceIntegrity({ animation: refs.state.animation!, isKnownObject: id => id === "keeper" })).not.toThrow();
  });

  // H-C7-P3 宿主顺序用例:拒绝→经 animation.set-anchor 编程口迁移锚→删除成功。
  // 迁移步按命令消费语义改写容器锚(端口写引擎权威态 + draft 回写同一合并面),
  // 证明 fail-closed 拒绝文案("请先迁移状态机锚再删除")现在指向一个真实存在的操作。
  it("reject→migrate→delete:锚被消费时拒绝,迁移到存活状态后删除成功", () => {
    const state = animation();
    state.stateMachine!.states.unshift({ id: "victim-state", name: "victim", modelId: "victim", clipId: "walk", loop: true });
    state.stateMachine!.initialStateId = "victim-state";
    state.stateMachine!.activeStateId = "victim-state";
    const refs = registry(state);
    expect(() => refs.pruneDeletedObjectReferences("victim")).toThrow(/请先迁移状态机锚再删除/);
    expect(refs.state.animation!.stateMachine!.states).toHaveLength(2); // 拒绝路径零变更

    // 迁移:命令合同 animation.set-anchor { initialStateId, activeStateId } → 锚落到存活状态。
    const machine = refs.state.animation!.stateMachine!;
    machine.initialStateId = "keep";
    machine.activeStateId = "keep";
    // 迁移后的锚经加载解析门仍然闭合(victim 对象此刻尚未删除,时间线帧引用仍可解析)。
    expect(() => resolveSceneReferenceIntegrity({ animation: refs.state.animation!, isKnownObject: id => id === "keeper" || id === "victim" })).not.toThrow();

    const result = refs.pruneDeletedObjectReferences("victim");
    expect(result.animationStatesConsumed).toEqual(["victim-state"]);
    expect(refs.state.animation!.stateMachine!.states.map(state => state.id)).toEqual(["keep"]);
    expect(refs.state.animation!.stateMachine!.initialStateId).toBe("keep");
    expect(refs.state.animation!.stateMachine!.activeStateId).toBe("keep");
    expect(() => resolveSceneReferenceIntegrity({ animation: refs.state.animation!, isKnownObject: id => id === "keeper" })).not.toThrow();
  });
});
