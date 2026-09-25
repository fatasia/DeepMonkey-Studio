import { describe, expect, it, vi } from "vitest";
import type { ModelTransform } from "@bim-studio/contracts";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { sceneCommandBus } from "./commandBus";
import {
  UnsupportedEngineEditCommandError,
  ViewerEngineCommandApplier,
  dispatchEngineEditCommand,
} from "./engineCommandApplier";
import { layerVisibilityCommand } from "./engineEditCommand";

/** 引擎桩:只实现批 0 applier 触达的三个 setter,逐次记录调用(method + 参数快照)。 */
function stubEngine() {
  const calls: string[] = [];
  const engine = {
    applySelectionTransform(transform: ModelTransform): void {
      calls.push(`applySelectionTransform:${JSON.stringify(transform)}`);
    },
    setLayerVisible(modelId: string, nodeId: string, visible: boolean): void {
      calls.push(`setLayerVisible:${modelId}:${nodeId}:${visible}`);
    },
    setVisible(id: string, visible: boolean): void {
      calls.push(`setVisible:${id}:${visible}`);
    },
  };
  return { engine: engine as unknown as ViewerEngine, calls };
}

const transform: ModelTransform = {
  position: { x: 10, y: 20, z: 30 },
  rotation: { x: 0, y: Math.PI / 2, z: 0 },
  scale: { x: 2, y: 2, z: 2 },
};

describe("ViewerEngineCommandApplier(等价性:命令层执行 == 现状直调)", () => {
  it("图层级可见性:setLayerState + layerId → 一次 setLayerVisible(modelId, layerId, visible),参数与现状直调逐项一致", () => {
    const { engine, calls } = stubEngine();
    const applier = new ViewerEngineCommandApplier(engine);

    // 现状直调参照表达式:engine.setLayerVisible(model.id, node.id, visible)
    engine.setLayerVisible("m1", "l1", false);
    const directCalls = [...calls];
    calls.length = 0;

    applier.apply({
      kind: "setLayerState",
      id: "editcmd-t1",
      baseRevision: 0,
      label: "切换图层可见性",
      target: { modelId: "m1", layerId: "l1" },
      patch: { visible: false },
    });

    expect(calls).toEqual(directCalls);
    expect(calls).toEqual(["setLayerVisible:m1:l1:false"]);
  });

  it("模型级可见性:无 layerId → 一次 setVisible(modelId, visible),不触碰图层级 setter", () => {
    const { engine, calls } = stubEngine();
    const applier = new ViewerEngineCommandApplier(engine);

    applier.apply({
      kind: "setLayerState",
      id: "editcmd-t2",
      baseRevision: 0,
      label: "切换图层可见性",
      target: { modelId: "m1" },
      patch: { visible: true },
    });

    expect(calls).toEqual(["setVisible:m1:true"]);
  });

  it("变换:setTransform → 一次 applySelectionTransform(transform),TRS 全量原样转交", () => {
    const { engine, calls } = stubEngine();
    const applier = new ViewerEngineCommandApplier(engine);

    // 现状直调参照表达式:engine.applySelectionTransform(transform)
    engine.applySelectionTransform(transform);
    const directCalls = [...calls];
    calls.length = 0;

    applier.apply({
      kind: "setTransform",
      id: "editcmd-t3",
      baseRevision: 0,
      label: "编辑三维对象",
      target: { modelId: "m1" },
      transform,
    });

    expect(calls).toEqual(directCalls);
  });

  it("patch 含批 0 未支持字段(locked)→ 抛 UnsupportedEngineEditCommandError 且零 setter 调用", () => {
    const { engine, calls } = stubEngine();
    const applier = new ViewerEngineCommandApplier(engine);

    expect(() =>
      applier.apply({
        kind: "setLayerState",
        id: "editcmd-t4",
        baseRevision: 0,
        label: "切换图层可见性",
        target: { modelId: "m1", layerId: "l1" },
        patch: { locked: true },
      }),
    ).toThrow(UnsupportedEngineEditCommandError);
    expect(calls).toEqual([]);
  });

  it("patch 混入未支持字段(visible + locked)→ 拒绝整条命令,不做部分应用", () => {
    const { engine, calls } = stubEngine();
    const applier = new ViewerEngineCommandApplier(engine);

    expect(() =>
      applier.apply({
        kind: "setLayerState",
        id: "editcmd-t5",
        baseRevision: 0,
        label: "切换图层可见性",
        target: { modelId: "m1", layerId: "l1" },
        patch: { visible: true, locked: false },
      }),
    ).toThrow(UnsupportedEngineEditCommandError);
    expect(calls).toEqual([]);
  });

  it("patch.visible 非 boolean → 拒绝", () => {
    const { engine, calls } = stubEngine();
    const applier = new ViewerEngineCommandApplier(engine);

    expect(() =>
      applier.apply({
        kind: "setLayerState",
        id: "editcmd-t6",
        baseRevision: 0,
        label: "切换图层可见性",
        target: { modelId: "m1" },
        patch: { visible: undefined as unknown as boolean },
      }),
    ).toThrow(UnsupportedEngineEditCommandError);
    expect(calls).toEqual([]);
  });
});

describe("dispatchEngineEditCommand(接线全链路)", () => {
  it("engine 为 undefined → 静默跳过,不发布命令(与现状 engine?.setLayerVisible 的 no-op 一致)", () => {
    const before = sceneCommandBus.getLog().length;
    const beforeRevision = sceneCommandBus.getRevision();

    dispatchEngineEditCommand(undefined, layerVisibilityCommand("zh-CN", { modelId: "m1", layerId: "l1" }, true));

    expect(sceneCommandBus.getLog().length).toBe(before);
    expect(sceneCommandBus.getRevision()).toBe(beforeRevision);
  });

  it("engine 就绪 → 命令进共享总线、applier 原样调 setter、revision 单调、日志可回放", () => {
    const { engine, calls } = stubEngine();
    const beforeLog = sceneCommandBus.getLog().length;
    const beforeRevision = sceneCommandBus.getRevision();
    const events: number[] = [];
    const unsubscribe = sceneCommandBus.subscribe((event) => events.push(event.revision));

    const published = dispatchVisibility(engine, "m1", "l1", false);

    unsubscribe();

    expect(calls).toEqual(["setLayerVisible:m1:l1:false"]);
    expect(published.id).toMatch(/^editcmd-\d+$/);
    expect(published.baseRevision).toBe(beforeRevision);
    expect(sceneCommandBus.getRevision()).toBe(beforeRevision + 1);
    expect(events).toEqual([beforeRevision + 1]);
    const log = sceneCommandBus.getLog();
    expect(log.length).toBe(beforeLog + 1);
    expect(log[log.length - 1]?.command.id).toBe(published.id);

    // 日志可回放:经生产 applier 对桩引擎重放,setter 收到同参数调用(引擎重建恢复投影的既有缝)。
    const replayTarget = stubEngine();
    const replayed = sceneCommandBus.replay(new ViewerEngineCommandApplier(replayTarget.engine));
    expect(replayed).toBe(sceneCommandBus.getLog().length);
    expect(replayTarget.calls).toContain("setLayerVisible:m1:l1:false");
  });

  it("命令工厂 label 中英文齐备,target 携带 modelId + layerId", () => {
    expect(layerVisibilityCommand("zh-CN", { modelId: "m1", layerId: "l1" }, true)).toEqual({
      kind: "setLayerState",
      label: "切换图层可见性",
      target: { modelId: "m1", layerId: "l1" },
      patch: { visible: true },
    });
    expect(layerVisibilityCommand("en-US", { modelId: "m1" }, false).label).toBe("Toggle layer visibility");
  });
});

function dispatchVisibility(engine: ViewerEngine, modelId: string, layerId: string, visible: boolean) {
  dispatchEngineEditCommand(engine, layerVisibilityCommand("zh-CN", { modelId, layerId }, visible));
  const log = sceneCommandBus.getLog();
  const last = log[log.length - 1];
  if (!last) throw new Error("dispatch 后总线日志为空");
  return { id: last.command.id, baseRevision: last.command.baseRevision };
}
