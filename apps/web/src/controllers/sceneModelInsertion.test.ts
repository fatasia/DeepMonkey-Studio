import { describe, expect, it, vi } from "vitest";
import type { ModelRecord } from "@bim-studio/contracts";
import { createSceneEditorController } from "./sceneEditorController";
import type { SceneEditorControllerContext } from "./sceneEditorControllerContext";

function setup(existing = false) {
  const loaded = { id: "new", name: "small part", kind: "model" };
  const engine = { listModels: vi.fn(() => existing ? [loaded] : []), loadManifest: vi.fn().mockResolvedValue(loaded), select: vi.fn(), focusModel: vi.fn() };
  const context = { engine, locale: "zh-CN", setBusy: vi.fn(), setMessage: vi.fn(), setRevision: vi.fn(), setSceneOrganizationSelection: vi.fn(), recordSceneEdit: vi.fn(), showError: vi.fn() };
  const controller = createSceneEditorController(context as unknown as SceneEditorControllerContext);
  const model = { id: "new", name: "small part", status: "ready", manifest: { modelId: "new", geometryUrl: "/model.glb" } } as ModelRecord;
  return { controller, model, context, engine };
}

describe("scene model insertion", () => {
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
