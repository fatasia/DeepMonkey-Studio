import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateSceneSnapshotV1, type SceneSnapshot } from "@bim-studio/contracts";
import { createRenameApplicationCommand } from "@bim-studio/studio-core";
import fixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { api } from "../api";
import { ApplicationSession } from "../studio/applicationSession";
import { createSceneWorkspaceNavigationActions } from "./sceneWorkspaceNavigationActions";

afterEach(() => vi.restoreAllMocks());

function setup() {
  const scene = fixture as SceneSnapshot;
  const application = migrateSceneSnapshotV1(scene);
  const session = new ApplicationSession();
  const actions = createSceneWorkspaceNavigationActions({
    project: undefined, scenes: [scene], applicationSessionRef: { current: session },
    navigate: vi.fn(), saveActiveApplication: vi.fn(), dispatchApplicationCommand: vi.fn(),
    showError: vi.fn(), setActiveScene: vi.fn(), setBusy: vi.fn(), setMessage: vi.fn(),
  });
  return { scene, application, session, actions };
}

describe("direct scene script entry", () => {
  it("restores an existing application and its scripts without creating another one", async () => {
    const { scene, application, session, actions } = setup();
    vi.spyOn(api, "listApplications").mockResolvedValue([application]);
    const create = vi.spyOn(api, "createApplication");
    await actions.ensureApplicationForScene(scene);
    expect(session.getDocument()).toEqual(application);
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps an already-open document and undo history instead of reading an older server copy", async () => {
    const { scene, application, session, actions } = setup();
    session.openDocument(application);
    session.store.dispatch(createRenameApplicationCommand("未保存草稿"));
    const before = session.getDocument();
    const list = vi.spyOn(api, "listApplications");
    expect(await actions.ensureApplicationForScene(scene)).toBe(before);
    expect(session.store.getState().dirty).toBe(true);
    expect(list).not.toHaveBeenCalled();
  });

  it("does not open a late response into a different workspace", async () => {
    const { scene, application, session, actions } = setup();
    vi.spyOn(api, "listApplications").mockResolvedValue([application]);
    await expect(actions.ensureApplicationForScene(scene, () => false)).rejects.toThrow("场景已切换");
    expect(session.getDocument()).toBeUndefined();
  });
});
