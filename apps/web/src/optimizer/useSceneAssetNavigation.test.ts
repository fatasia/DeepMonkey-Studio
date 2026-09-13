import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppViewBindings } from "../views/appViewBindings";
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
    const flush = vi.fn();
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

    expect(replaceModelManifest).toHaveBeenCalledWith("instance", { modelId: "optimized" });
    expect(loadModel).not.toHaveBeenCalled();
    expect(flush).toHaveBeenLastCalledWith("应用优化并替换素材");
    expect(navigate).toHaveBeenCalledWith({ view: "studio", projectId: "p", sceneId: "s" }, true);
    expect(setMessage).toHaveBeenCalledWith(expect.stringContaining("实例身份、位姿与绑定保持不变"));
  });
});
