import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { createSceneFileTransferActions } from "./sceneFileTransferActions";

const files = vi.hoisted(() => ({ exportFbxFile: vi.fn(), exportGlbFile: vi.fn(), exportLooseScene: vi.fn(), exportScenePackage: vi.fn(), readSceneFile: vi.fn() }));
vi.mock("../sceneFiles", () => files);
vi.mock("../api", () => ({ api: {} }));

function fixture() {
  const engine = { isSceneSnapshotReady: vi.fn(() => false), exportSceneGlb: vi.fn(), exportSceneFbx: vi.fn() };
  const showError = vi.fn(), applyScene = vi.fn(), snapshot = vi.fn<() => SceneSnapshot | undefined>(() => undefined);
  const context = { engine, project: { id: "p", models: [] }, activeScene: { id: "s" }, sceneName: "场景", showError, setBusy: vi.fn(), setMessage: vi.fn() };
  const actions = createSceneFileTransferActions(context as unknown as Parameters<typeof createSceneFileTransferActions>[0], snapshot, applyScene);
  return { actions, engine, showError, applyScene, snapshot };
}
beforeEach(() => vi.clearAllMocks());

describe("scene export readiness", () => {
  it("does not export an incomplete live scene and reports a useful failure for every format", async () => {
    const f = fixture();
    f.actions.exportSceneConfig(); await f.actions.exportSingleFileScene(); await f.actions.exportGlbScene(); await f.actions.exportFbxScene();
    expect(f.showError).toHaveBeenCalledTimes(4);
    expect(files.exportLooseScene).not.toHaveBeenCalled(); expect(files.exportScenePackage).not.toHaveBeenCalled();
    expect(f.engine.exportSceneGlb).not.toHaveBeenCalled(); expect(f.engine.exportSceneFbx).not.toHaveBeenCalled();
  });
  it("allows exporting an explicit stored snapshot without depending on the rebuilding viewer", async () => {
    const f = fixture(); const saved = { id: "s", projectId: "p", models: [], primitives: [] } as unknown as SceneSnapshot;
    f.actions.exportSceneConfig(saved); await f.actions.exportSingleFileScene(saved);
    expect(files.exportLooseScene).toHaveBeenCalledWith(saved);
    expect(files.exportScenePackage).toHaveBeenCalledWith(saved, []);
    expect(f.showError).not.toHaveBeenCalled();
  });
  it("rejects GLB export after scene restoration fails and still permits a ready empty scene", async () => {
    const f = fixture(); const saved = { id: "other", name: "空场景" } as SceneSnapshot;
    await f.actions.exportGlbScene(saved);
    expect(f.applyScene).toHaveBeenCalledWith(saved, false);
    expect(f.engine.exportSceneGlb).not.toHaveBeenCalled();
    f.engine.isSceneSnapshotReady.mockReturnValue(true); f.engine.exportSceneGlb.mockResolvedValue(new ArrayBuffer(4));
    await f.actions.exportGlbScene(saved);
    expect(f.engine.exportSceneGlb).toHaveBeenCalledOnce(); expect(files.exportGlbFile).toHaveBeenCalledOnce();
  });
});
