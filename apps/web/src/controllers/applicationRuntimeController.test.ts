import pureFixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { migrateSceneSnapshotV1, type ApplicationDocument, type SceneSnapshot, type ScriptModule } from "@bim-studio/contracts";
import { createRenameApplicationCommand } from "@bim-studio/studio-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { ApplicationSession } from "../studio/applicationSession";
import { createApplicationRuntimeController } from "./applicationRuntimeController";
import * as thumbnails from "../studio/sceneThumbnailCapture";

afterEach(() => vi.restoreAllMocks());

describe("scene editor destination", () => {
  function setup() {
    const source = migrateSceneSnapshotV1(pureFixture as SceneSnapshot);
    const session = new ApplicationSession(); session.openDocument(source);
    const context = controllerContext(session, source, vi.fn());
    context.route = { view: "studio", projectId: source.metadata.projectId, applicationId: source.metadata.id, sceneId: source.scenes[0]!.id };
    return { source, context, controller: createApplicationRuntimeController(context) };
  }

  it("opens an existing page when switching a direct 3D route to 2D", () => {
    const { source, context, controller } = setup();
    controller.returnFromSceneEditor("dashboard");
    expect(context.navigate).toHaveBeenCalledWith(expect.objectContaining({ view: "dashboard", pageId: source.pages[0]!.id, applicationId: source.metadata.id }));
    expect(context.showError).not.toHaveBeenCalled();
  });

  it("preserves the separate Back to scenes action", () => {
    const { context, controller } = setup();
    controller.returnFromSceneEditor();
    expect(context.navigate).toHaveBeenCalledWith({ view: "manager" });
  });

  it("refuses to open a stale application from another route", () => {
    const { context } = setup();
    context.route = { ...context.route, applicationId: "other" };
    createApplicationRuntimeController(context).returnFromSceneEditor("dashboard");
    expect(context.navigate).not.toHaveBeenCalled();
    expect(context.showError).toHaveBeenCalledOnce();
  });
});

describe("applicationRuntimeController script replacement", () => {
  it("saves a frozen application without trying to mutate its scene thumbnail", async () => {
    const source = migrateSceneSnapshotV1(pureFixture as SceneSnapshot);
    const session = new ApplicationSession(); session.openDocument(source);
    const original = session.getDocument()!;
    expect(Object.isFrozen(original.scenes[0])).toBe(true);
    vi.spyOn(thumbnails, "captureSceneThumbnail").mockReturnValue("data:image/jpeg;base64,fixture");
    const save = vi.spyOn(api, "saveApplication").mockImplementation(async document => structuredClone(document));
    const showError = vi.fn();
    const controller = createApplicationRuntimeController({
      ...controllerContext(session, source, showError), activeScene: pureFixture as SceneSnapshot,
    });
    await expect(controller.saveActiveApplication()).resolves.toEqual(source);
    expect(save).toHaveBeenCalledOnce(); expect(showError).not.toHaveBeenCalled();
    expect(original).toEqual(source); expect(session.store.getState().dirty).toBe(false);
  });

  it("restores the original scripts after a failed save without reverting concurrent project edits", async () => {
    const source = migrateSceneSnapshotV1(pureFixture as SceneSnapshot);
    const session = new ApplicationSession();
    session.openDocument(source);
    let rejectSave: ((reason: Error) => void) | undefined;
    vi.spyOn(api, "saveApplication").mockReturnValue(new Promise<ApplicationDocument>((_resolve, reject) => { rejectSave = reject; }));
    const showError = vi.fn();
    const controller = createApplicationRuntimeController(controllerContext(session, source, showError));
    const replacement = [script("remote-script", "远端脚本")];

    const saving = controller.replaceBehaviorScripts(replacement);
    controller.dispatchApplicationCommand(createRenameApplicationCommand("等待保存时的新名称"));
    rejectSave?.(new Error("storage unavailable"));

    await expect(saving).rejects.toThrow("已恢复原脚本");
    const document = session.getDocument();
    expect(document?.scripts).toEqual(source.scripts);
    expect(document?.metadata.name).toBe("等待保存时的新名称");
    expect(showError).toHaveBeenCalledWith(expect.objectContaining({ message: "storage unavailable" }));
  });
});

function controllerContext(session: ApplicationSession, source: ApplicationDocument, showError: (reason: unknown) => void): Parameters<typeof createApplicationRuntimeController>[0] {
  const setter = vi.fn();
  return {
    applicationSessionRef: { current: session },
    behaviorManagerRef: { current: undefined },
    behaviorCommandQueueRef: { current: Promise.resolve() },
    engine: undefined,
    project: undefined,
    activeScene: undefined,
    activeApplication: source,
    activeTopology: undefined,
    managerApplications: [],
    currentUser: undefined,
    route: { view: "manager" },
    locale: "zh-CN",
    sceneBehaviorEntries: [],
    sceneBehaviorPaused: false,
    navigate: vi.fn(),
    showError,
    sortScenesByTime: (items) => items,
    setActiveScene: setter,
    setAutoSaveEnabled: setter,
    setBusy: setter,
    setExpandedModels: setter,
    setMessage: setter,
    setRevision: setter,
    setSceneBehaviorActive: setter,
    setSceneBehaviorEntries: setter,
    setSceneBehaviorLogs: setter,
    setSceneBehaviorPaused: setter,
    setScenes: setter,
  };
}

function script(id: string, name: string): ScriptModule {
  return {
    id,
    name,
    enabled: true,
    apiVersion: "1.0",
    entrypoint: "behavior",
    runtime: "worker-sandbox",
    code: "export function onStart(ctx) { ctx.log('ready'); }",
    lifecycle: ["onStart"],
    capabilities: ["studio.runtime"],
    permissions: ["scene.read"],
  };
}
