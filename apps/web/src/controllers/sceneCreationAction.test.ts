import { describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { createSceneCreationAction } from "./sceneCreationAction";
import type { ScenePersistenceControllerContext } from "./scenePersistenceControllerContext";

vi.mock("../api", () => ({ api: { saveScene: vi.fn(async (scene) => scene) } }));

describe("scene creation isolation", () => {
  it("clears previous scene objects and transient light selection before creating", async () => {
    const noop = vi.fn();
    const setSelectedLightId = vi.fn();
    const engine = new Proxy({ clearSceneModels: vi.fn(), applyCamera: vi.fn() }, { get: (target, key) => key in target ? target[key as keyof typeof target] : noop });
    const base = {
      engine,
      project: { id: "project" },
      configuredDefaultEnvironment: { gridVisible: true, backgroundColor: "#000000", skybox: "studio" },
      sceneApplyVersionRef: { current: 0 },
      primitiveColors: { current: new Map() },
      sortScenesByTime: (items: unknown[]) => items,
      setSelectedLightId,
    };
    const context = new Proxy(base, { get: (target, key) => key in target ? target[key as keyof typeof target] : noop }) as unknown as ScenePersistenceControllerContext;
    const createScene = createSceneCreationAction(context, vi.fn(async () => undefined));

    await createScene("空白场景");

    expect(api.saveScene).toHaveBeenCalledOnce();
    expect(engine.clearSceneModels).toHaveBeenCalledOnce();
    expect(setSelectedLightId).toHaveBeenCalledWith("");
  });
});
