import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRecord } from "@bim-studio/contracts";
import { api } from "../api";
import { createSceneEditorController } from "./sceneEditorController";
import type { SceneEditorControllerContext } from "./sceneEditorControllerContext";

vi.mock("../api", () => ({
  api: {
    uploadModel: vi.fn(),
    getProject: vi.fn(),
  },
}));

afterEach(() => vi.clearAllMocks());

function setup(existing = false) {
  const loaded = { id: "new", name: "small part", kind: "model" };
  const engine = { listModels: vi.fn(() => existing ? [loaded] : []), loadManifest: vi.fn().mockResolvedValue(loaded), select: vi.fn(), focusModel: vi.fn() };
  const context = { engine, locale: "zh-CN", setBusy: vi.fn(), setMessage: vi.fn(), setRevision: vi.fn(), setSceneOrganizationSelection: vi.fn(), recordSceneEdit: vi.fn(), showError: vi.fn() };
  const controller = createSceneEditorController(context as unknown as SceneEditorControllerContext);
  const model = { id: "new", name: "small part", status: "ready", manifest: { modelId: "new", geometryUrl: "/model.glb" } } as ModelRecord;
  return { controller, model, context, engine };
}

describe("scene model insertion", () => {
  it("returns the authoritative ready model after upload conversion finishes", async () => {
    const h = setup();
    const queued = { id: "upload-1", name: "assembly.step", status: "processing", progress: 28 } as ModelRecord;
    const ready = {
      ...queued,
      status: "ready",
      progress: 100,
      manifest: { modelId: queued.id, viewerKind: "gltf", geometryUrl: "/converted/assembly.glb" },
    } as ModelRecord;
    vi.mocked(api.uploadModel).mockResolvedValueOnce(queued);
    vi.mocked(api.getProject).mockResolvedValueOnce({ id: "project-1", models: [ready] } as never);
    const refreshProject = vi.fn().mockResolvedValue(undefined);
    const controller = createSceneEditorController({
      ...h.context,
      project: { id: "project-1", models: [] },
      rvtConversionMode: "native-glb",
      rvtRevitVersion: "auto",
      refreshProject,
      setUploading: vi.fn(),
      uploadRef: { current: null },
    } as unknown as SceneEditorControllerContext);

    await expect(controller.uploadModels([new File(["mesh"], "assembly.step")])).resolves.toEqual([ready]);
    expect(api.getProject).toHaveBeenCalledWith("project-1");
    expect(refreshProject).toHaveBeenCalledOnce();
  });

  it("does not open the insert workflow for a failed conversion", async () => {
    const h = setup();
    const queued = { id: "upload-2", name: "broken.rvt", status: "processing" } as ModelRecord;
    vi.mocked(api.uploadModel).mockResolvedValueOnce(queued);
    vi.mocked(api.getProject).mockResolvedValueOnce({ id: "project-1", models: [{ ...queued, status: "failed", message: "转换失败" }] } as never);
    const refreshProject = vi.fn();
    const controller = createSceneEditorController({
      ...h.context,
      project: { id: "project-1", models: [] },
      rvtConversionMode: "native-glb",
      rvtRevitVersion: "auto",
      refreshProject,
      setUploading: vi.fn(),
      uploadRef: { current: null },
    } as unknown as SceneEditorControllerContext);

    await expect(controller.uploadModels([new File(["broken"], "broken.rvt")])).resolves.toEqual([]);
    expect(h.context.showError).toHaveBeenCalledWith(expect.objectContaining({ message: "转换失败" }));
    expect(refreshProject).not.toHaveBeenCalled();
  });

  it("creates a new identity when a former asset ID now belongs to a replaced instance", async () => {
    const h = setup();
    h.engine.listModels.mockReturnValue([{ id: "new", name: "kept binding", kind: "model", assetModelId: "replacement" } as never]);
    await h.controller.loadModel(h.model);
    const insertedId = h.engine.loadManifest.mock.calls[0]?.[1];
    expect(insertedId).toEqual(expect.any(String)); expect(insertedId).not.toBe("new");
    expect(h.engine.select).toHaveBeenCalledWith(insertedId);
    expect(h.context.recordSceneEdit).toHaveBeenCalledOnce();
  });
  it("focuses newly inserted small models and records one author edit", async () => {
    const h = setup(); await h.controller.loadModel(h.model);
    expect(h.engine.select).toHaveBeenCalledWith("new");
    expect(h.engine.focusModel).toHaveBeenCalledOnce();
    expect(h.context.recordSceneEdit).toHaveBeenCalledTimes(1);
  });
  it("selects existing assets without refocusing or another history edit", async () => {
    const h = setup(true); await h.controller.loadModel(h.model);
    expect(h.engine.select).toHaveBeenCalledWith("new");
    expect(h.engine.focusModel).not.toHaveBeenCalled();
    expect(h.context.recordSceneEdit).not.toHaveBeenCalled();
  });
  it("never steals the restored camera/selection in silent scene replay", async () => {
    const h = setup(); await h.controller.loadModel(h.model, true);
    expect(h.engine.focusModel).not.toHaveBeenCalled();
    expect(h.engine.select).not.toHaveBeenCalled();
    expect(h.context.recordSceneEdit).not.toHaveBeenCalled();
  });
  it("rejects unavailable resources without changing the scene", async () => {
    const h = setup(); await h.controller.loadModel({ ...h.model, status: "failed" });
    expect(h.engine.loadManifest).not.toHaveBeenCalled();
    expect(h.context.recordSceneEdit).not.toHaveBeenCalled();
  });
});
