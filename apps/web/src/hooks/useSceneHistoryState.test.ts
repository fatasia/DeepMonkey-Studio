import { afterEach, describe, expect, it, vi } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { SceneAuthoringHistory } from "../studio/sceneAuthoringHistory";
import type { SceneEditTransaction } from "./useSceneHistoryState";
import { createSceneEditTransaction, useSceneHistoryState } from "./useSceneHistoryState";

vi.mock("react", () => ({ useRef: (current: unknown) => ({ current }), useState: (value: unknown) => [value, vi.fn()], useEffect: vi.fn() }));
vi.mock("react-dom", () => ({ flushSync: (change: () => void) => change() }));

// 防抖计时器走 window.*；vitest 默认 node 环境，桥接到全局计时器（与 fake timers 兼容）。
(globalThis as { window: unknown }).window = {
  setTimeout: (change: () => void, ms?: number) => setTimeout(change, ms),
  clearTimeout: (timer: number) => clearTimeout(timer),
};

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function baseScene(name: string): SceneSnapshot {
  return {
    schemaVersion: 1, id: "scene", projectId: "project", name,
    camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
    models: [], primitives: [], measurements: [],
    createdAt: "2026-09-27T00:00:00.000Z", updatedAt: "2026-09-27T00:00:00.000Z",
  };
}

/** 夹具：live 即画布事实状态；工厂每次深拷贝，与生产快照工厂同构；undo/redo 显式应用回 live，与 applyScene 语义一致。 */
function harness(initial = baseScene("初始")) {
  vi.useFakeTimers();
  const state = useSceneHistoryState({ activeScene: structuredClone(initial), routeView: "studio", sceneBehaviorActive: false, animationPlaying: false });
  const history = state.sceneHistoryRef.current;
  const live = structuredClone(initial);
  history.reset(structuredClone(initial));
  state.sceneSnapshotFactoryRef.current = () => structuredClone(live);
  return {
    state, live, history,
    addModel: (modelId: string) => { live.models = [...live.models, { modelId } as SceneSnapshot["models"][number]]; },
    record: (label: string) => state.sceneHistoryRecordRef.current(label),
    rename: (name: string) => { live.name = name; },
    apply: (snapshot: SceneSnapshot | undefined) => { if (snapshot) { live.name = snapshot.name; live.models = snapshot.models; } return snapshot; },
  };
}

describe("scene edit unified transaction (T27)", () => {
  it("suppresses flush and scheduled restoration writes while apply is active", () => {
    const h = harness();
    h.rename("A"); h.record("A"); vi.advanceTimersByTime(220);
    const version = h.history.revision;
    h.state.sceneHistoryApplyingRef.current = true;
    h.rename("恢复中的规范化状态");
    h.state.flushSceneHistoryEdit(); h.record("恢复事件"); vi.advanceTimersByTime(500);
    expect(h.history.revision).toBe(version);
    expect(h.history.getState().undoLabel).toBe("A");
    h.state.sceneHistoryApplyingRef.current = false;
    h.rename("B"); h.record("B"); vi.advanceTimersByTime(220);
    expect(h.history.undo()?.name).toBe("A");
  });
  it("groups every edit made inside the window into one undo unit that restores the pre-transaction snapshot", () => {
    const h = harness();
    const transaction = h.state.beginSceneEditTransaction("替换素材");
    h.rename("半程一"); h.addModel("instance-a");
    h.record("窗口内的连续编辑");
    vi.advanceTimersByTime(300);
    expect(h.history.getState().canUndo).toBe(false);
    h.rename("半程二"); h.addModel("instance-b");
    transaction.commit("已替换素材，原有绑定与配置保留，可撤销");
    expect(h.history.getState()).toMatchObject({ canUndo: true, canRedo: false, undoLabel: "已替换素材，原有绑定与配置保留，可撤销" });
    h.apply(h.history.undo());
    expect(h.live).toMatchObject({ name: "初始", models: [] });
    expect(h.apply(h.history.redo())?.models.map((item) => item.modelId)).toEqual(["instance-a", "instance-b"]);
  });

  it("records nothing when a transaction commits without changes, and absorbs runSceneEdit commands into the open window", () => {
    const h = harness();
    const first = h.state.beginSceneEditTransaction("替换素材");
    first.commit();
    expect(h.history.getState().canUndo).toBe(false);
    const second = h.state.beginSceneEditTransaction("第二事务");
    expect(second).not.toBe(first);
    h.state.runSceneHistoryEdit(() => { h.rename("事务内的离散命令"); });
    vi.advanceTimersByTime(300);
    expect(h.history.getState().canUndo).toBe(false);
    second.commit("统一提交");
    expect(h.apply(h.history.undo())?.name).toBe("初始");
    expect(h.history.getState().canUndo).toBe(false);
  });

  it("re-entrant begin returns the open transaction and stale handles commit only once", () => {
    const h = harness();
    const first = h.state.beginSceneEditTransaction("替换素材");
    expect(h.state.beginSceneEditTransaction("其他标签")).toBe(first);
    h.rename("已替换");
    first.commit();
    h.state.beginSceneEditTransaction("替换素材").commit();
    expect(h.history.getState()).toMatchObject({ undoLabel: "替换素材" });
    expect(h.apply(h.history.undo())?.name).toBe("初始");
    expect(h.history.getState().canUndo).toBe(false);
  });

  it("rollback returns a deep copy of the pre-transaction snapshot, closes the window and leaves no entry", () => {
    const h = harness();
    const transaction = h.state.beginSceneEditTransaction("替换素材");
    h.rename("已替换"); h.addModel("instance-a");
    const before = transaction.rollback();
    expect(before?.name).toBe("初始");
    expect(transaction.active).toBe(false);
    before!.name = "回滚句柄可自由修改";
    expect(transaction.rollback()).toBeUndefined();
    expect(h.history.getState().canUndo).toBe(false);
    h.record("回滚后的普通编辑");
    vi.advanceTimersByTime(220);
    expect(h.apply(h.history.undo())?.name).toBe("初始");
  });

  it("keeps undo and redo interleaving stable around transactions", () => {
    const h = harness();
    h.rename("编辑一"); h.record("编辑一");
    vi.advanceTimersByTime(220);
    h.apply(h.history.undo());
    const transaction = h.state.beginSceneEditTransaction("替换素材");
    h.rename("编辑二"); h.addModel("instance");
    transaction.commit("替换素材");
    expect(h.history.redo()).toBeUndefined();
    h.apply(h.history.undo());
    expect(h.live).toMatchObject({ name: "初始", models: [] });
    expect(h.apply(h.history.redo())?.models.map((item) => item.modelId)).toEqual(["instance"]);
    h.apply(h.history.undo());
    h.rename("编辑三"); h.record("编辑三");
    vi.advanceTimersByTime(220);
    expect(h.history.redo()).toBeUndefined();
    expect(h.apply(h.history.undo())?.name).toBe("初始");
    expect(h.history.getState().canUndo).toBe(false);
  });

  it("keeps instance identity stable when undoing a committed asset replacement", () => {
    const h = harness();
    h.addModel("instance-a");
    h.record("插入实例");
    vi.advanceTimersByTime(220);
    const transaction = h.state.beginSceneEditTransaction("替换素材");
    h.addModel("instance-b");
    transaction.commit("已替换素材");
    h.apply(h.history.undo());
    expect(h.live.models.map((item) => item.modelId)).toEqual(["instance-a"]);
    h.apply(h.history.redo());
    expect(h.live.models.map((item) => item.modelId)).toEqual(["instance-a", "instance-b"]);
  });

  it("exposes the same transaction semantics through the standalone host contract", () => {
    const history = new SceneAuthoringHistory();
    const live = baseScene("初始");
    history.reset(structuredClone(live));
    const open = { current: undefined as SceneEditTransaction | undefined };
    const transaction = createSceneEditTransaction(open, {
      flush: () => undefined,
      capture: () => structuredClone(live),
      record: (snapshot, label) => { history.record(snapshot, label); },
    }, "宿主事务");
    live.name = "变更"; live.models = [{ modelId: "m" } as SceneSnapshot["models"][number]];
    transaction.commit("宿主提交");
    expect(open.current).toBeUndefined();
    expect(history.undo()).toMatchObject({ name: "初始", models: [] });
    expect(history.redo()?.models.map((item) => item.modelId)).toEqual(["m"]);
  });
});
