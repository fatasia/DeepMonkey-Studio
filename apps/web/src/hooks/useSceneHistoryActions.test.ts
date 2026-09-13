import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { useSceneHistoryActions } from "./useSceneHistoryActions";
import { assessWorkspaceRecovery } from "../studio/workspaceRecoveryDecision";
import { createWorkspaceRecoveryDraft, readWorkspaceRecoveryDraft } from "../studio/workspaceRecoveryStore";

const disk = vi.hoisted(() => ({ draft: undefined as unknown }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useEffect: vi.fn() }));
vi.mock("../studio/workspaceRecoveryStore", async original => ({
  ...await original<typeof import("../studio/workspaceRecoveryStore")>(),
  readWorkspaceRecoveryDraft: vi.fn(async () => structuredClone(disk.draft)),
  deleteWorkspaceRecoveryDraft: vi.fn(async () => { disk.draft = undefined; }),
}));

const server: SceneSnapshot = {
  schemaVersion: 1, id: "s", projectId: "p", name: "正式草稿",
  camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
  models: [], primitives: [], measurements: [],
  createdAt: "2026-09-09T01:00:00.000Z", updatedAt: "2026-09-09T03:00:00.000Z",
};

function workspace() {
  const draft = createWorkspaceRecoveryDraft("p", undefined, { ...server, name: "恢复的本地修改" }, "2026-09-09T02:00:00.000Z");
  disk.draft = structuredClone(draft);
  const applyScene = vi.fn(async () => undefined);
  const setRecoveryDraft = vi.fn();
  const setAutoSaveEnabled = vi.fn();
  const showError = vi.fn();
  const setRecoveryBusy = vi.fn();
  const decision = { current: "previous-decision" as string | undefined };
  const options = {
    state: {
      project: { id: "p" }, activeScene: server, route: { view: "studio", projectId: "p", sceneId: "s" },
      revision: 7, lastAutoSavedSceneRevisionRef: { current: 6 }, setAutoSaveEnabled, showError, setMessage: vi.fn(),
    },
    history: {
      recoveryDraft: draft, recoveryDecisionRef: decision, setRecoveryDraft, setRecoveryBusy,
      sceneHistoryApplyingRef: { current: false }, sceneHistoryRef: { current: { record: vi.fn() } },
      sceneSnapshotFactoryRef: { current: () => draft.scene }, flushSceneHistoryEdit: vi.fn(),
    },
    applyScene,
  } as unknown as Parameters<typeof useSceneHistoryActions>[0];
  return { actions: useSceneHistoryActions(options), applyScene, setRecoveryDraft, setAutoSaveEnabled, showError, setRecoveryBusy, decision };
}

beforeEach(() => vi.clearAllMocks());

describe("unsaved recovery lifecycle", () => {
  it("keeps restored content recoverable after a second reload until it is saved", async () => {
    const current = workspace();
    await current.actions.restoreRecoveryDraft();
    expect(current.applyScene).toHaveBeenCalledWith(expect.objectContaining({ name: "恢复的本地修改" }), false, { id: "p" }, false);
    expect(current.setAutoSaveEnabled).toHaveBeenCalledWith(false);
    expect(current.setRecoveryDraft).toHaveBeenCalledWith(undefined);
    const reloaded = await readWorkspaceRecoveryDraft("p", undefined, "s");
    expect(reloaded?.scene.name).toBe("恢复的本地修改");
    expect(assessWorkspaceRecovery(reloaded, server)).toBe("offer");
    expect(server.name).toBe("正式草稿");
  });

  it("retains the draft and permits retry when applying it fails", async () => {
    const current = workspace();
    const error = new Error("模型加载失败");
    current.applyScene.mockRejectedValueOnce(error);
    await expect(current.actions.restoreRecoveryDraft()).resolves.toBeUndefined();
    expect(current.showError).toHaveBeenCalledWith(error);
    expect(current.decision.current).toBe("previous-decision");
    expect(current.setRecoveryDraft).not.toHaveBeenCalled();
    expect(current.setRecoveryBusy).toHaveBeenLastCalledWith(false);
    expect(assessWorkspaceRecovery(await readWorkspaceRecoveryDraft("p", undefined, "s"), server)).toBe("offer");
    await current.actions.restoreRecoveryDraft();
    expect(current.applyScene).toHaveBeenCalledTimes(2);
    expect(current.setRecoveryDraft).toHaveBeenCalledWith(undefined);
  });

  it("explicit discard removes the copy without applying it or changing the server", async () => {
    const current = workspace();
    await current.actions.discardRecoveryDraft();
    expect(current.applyScene).not.toHaveBeenCalled();
    expect(assessWorkspaceRecovery(await readWorkspaceRecoveryDraft("p", undefined, "s"), server)).toBe("ignore");
    expect(server.name).toBe("正式草稿");
  });
});
