import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import type { AppViewBindings } from "../views/appViewBindings";
import type { SceneEditHistoryFlush, SceneEditTransaction } from "../hooks/useSceneHistoryState";
import { createSceneEditTransaction } from "../hooks/useSceneHistoryState";
const harness = vi.hoisted(() => ({ refs: [] as Array<{ current: unknown }>, index: 0, effects: [] as Array<() => void> }));
vi.mock("react", () => ({
  useRef: (current: unknown) => harness.refs[harness.index++] ?? (harness.refs[harness.index - 1] = { current }),
  useState: (value: unknown) => [value, vi.fn()],
  useEffect: (effect: () => void) => harness.effects.push(effect),
}));
import { useSceneAssetNavigation } from "./useSceneAssetNavigation";
beforeEach(() => { harness.refs = []; harness.index = 0; harness.effects = []; });

describe("scene asset continuation", () => {
  it("waits for snapshot readiness without consuming the insertion intent", async () => {
    let ready = false;
    const loadModel = vi.fn().mockResolvedValue({ id: "m" });
    const navigate = vi.fn();
    const bindings = { state: {
      route: { view: "studio", projectId: "p", sceneId: "s", insertModelId: "m" },
      project: { id: "p", models: [{ id: "m", name: "Model", status: "ready", manifest: {} }] },
      activeScene: { id: "s", projectId: "p" }, busy: false,
      engine: { isSceneSnapshotReady: () => ready, listModels: () => [] }, setMessage: vi.fn(),
    }, sceneEditor: { loadModel }, scenePersistence: {}, actions: { navigate } } as unknown as AppViewBindings;
    const render = () => { harness.index = 0; harness.effects = []; useSceneAssetNavigation(bindings); harness.effects.forEach(effect => effect()); };
    render(); expect(loadModel).not.toHaveBeenCalled();
    ready = true; render(); await Promise.resolve();
    expect(loadModel).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith({ view: "studio", projectId: "p", sceneId: "s" }, true);
  });

  it("replaces the originating instance after optimization without inserting a duplicate", async () => {
    const loadModel = vi.fn();
    const replaceModelManifest = vi.fn().mockResolvedValue(undefined);
    const navigate = vi.fn();
    const setMessage = vi.fn();
    // T27：夹具复用生产事务工厂；替换素材必须作为单一事务条目落入统一撤销栈。
    const flush = vi.fn() as unknown as SceneEditHistoryFlush;
    const record = vi.fn();
    const transactionOpen: { current: SceneEditTransaction | undefined } = { current: undefined };
    flush.beginTransaction = (label: string) => createSceneEditTransaction(transactionOpen, {
      flush: () => flush(),
      capture: () => ({}) as never,
      record,
    }, label);
    const engine = {
      isSceneSnapshotReady: () => true,
      listModels: () => [{ id: "instance", name: "设备安装板", kind: "model", assetModelId: "source" }],
      replaceModelManifest,
      select: vi.fn(),
    };
    const bindings = { state: {
      route: { view: "studio", projectId: "p", sceneId: "s", insertModelId: "optimized", replaceModelInstanceId: "instance" },
      project: { id: "p", models: [{ id: "optimized", name: "Optimized", status: "ready", manifest: { modelId: "optimized" } }] },
      activeScene: { id: "s", projectId: "p" }, busy: false, engine, setMessage,
      setSceneOrganizationSelection: vi.fn(), setRevision: vi.fn(), showError: vi.fn(),
    }, sceneEditor: { loadModel }, scenePersistence: {}, sceneHistory: { flush }, actions: { navigate } } as unknown as AppViewBindings;
    useSceneAssetNavigation(bindings);
    harness.effects.forEach(effect => effect());

    await vi.waitFor(() => expect(replaceModelManifest).toHaveBeenCalled());
    expect(bindings.state.showError).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());

    expect(replaceModelManifest).toHaveBeenCalledWith("instance", { modelId: "optimized" }, expect.any(Function));
    const canCommit = replaceModelManifest.mock.calls[0]?.[2] as () => boolean;
    expect(canCommit()).toBe(true);
    bindings.state.route.view = "optimizer";
    expect(canCommit()).toBe(false);
    expect(loadModel).not.toHaveBeenCalled();
    expect(flush).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(expect.anything(), "应用优化并替换素材");
    expect(navigate).toHaveBeenCalledWith({ view: "studio", projectId: "p", sceneId: "s" }, true);
    expect(setMessage).toHaveBeenCalledWith(expect.stringContaining("实例身份、位姿与绑定保持不变"));
  });

  it("rolls a failed optimized replacement back to the pre-transaction snapshot (T27)", async () => {
    const replaceModelManifest = vi.fn().mockRejectedValue(new Error("几何桥解析失败"));
    const navigate = vi.fn();
    const before = { id: "s", name: "事务前" } as SceneSnapshot;
    const applyScene = vi.fn(async () => undefined);
    const flush = vi.fn() as unknown as SceneEditHistoryFlush;
    const transactionOpen: { current: SceneEditTransaction | undefined } = { current: undefined };
    flush.beginTransaction = (label: string) => createSceneEditTransaction(transactionOpen, {
      flush: () => flush(), capture: () => before, record: vi.fn(),
    }, label);
    const engine = {
      isSceneSnapshotReady: () => true,
      listModels: () => [{ id: "instance", name: "设备安装板", kind: "model", assetModelId: "source" }],
      replaceModelManifest,
      select: vi.fn(),
    };
    const bindings = { state: {
      route: { view: "studio", projectId: "p", sceneId: "s", insertModelId: "optimized", replaceModelInstanceId: "instance" },
      project: { id: "p", models: [{ id: "optimized", name: "Optimized", status: "ready", manifest: { modelId: "optimized" } }] },
      activeScene: { id: "s", projectId: "p" }, busy: false, engine, setMessage: vi.fn(),
      setSceneOrganizationSelection: vi.fn(), setRevision: vi.fn(), showError: vi.fn(),
    }, sceneEditor: { loadModel: vi.fn() }, scenePersistence: { applyScene }, sceneHistory: { flush }, actions: { navigate } } as unknown as AppViewBindings;
    useSceneAssetNavigation(bindings);
    harness.effects.forEach(effect => effect());

    await vi.waitFor(() => expect(applyScene).toHaveBeenCalledWith(before, false, expect.objectContaining({ id: "p" }), false));
    expect(bindings.state.showError).toHaveBeenCalledWith(expect.objectContaining({ message: "几何桥解析失败" }));
    expect(navigate).not.toHaveBeenCalled();
  });
});
