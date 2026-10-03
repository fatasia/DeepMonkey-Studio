import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateScene, type SceneSnapshot } from "@bim-studio/contracts";
import { api } from "../api";
import { createSceneCreationAction } from "./sceneCreationAction";
import type { ScenePersistenceControllerContext } from "./scenePersistenceControllerContext";

vi.mock("../api", () => ({ api: { saveScene: vi.fn(async (scene) => scene) } }));

describe("scene creation isolation", () => {
  beforeEach(() => {
    vi.mocked(api.saveScene).mockClear();
  });

  it("clears previous scene objects and transient light selection before creating", async () => {
    const { context, engine, setSelectedLightId, setRootLayerOrder } = fixture();
    const createScene = createSceneCreationAction(context, vi.fn(async () => undefined));

    await createScene("空白场景");

    expect(api.saveScene).toHaveBeenCalledOnce();
    expect(engine.clearSceneModels).toHaveBeenCalledOnce();
    expect(setSelectedLightId).toHaveBeenCalledWith("");
    expect(setRootLayerOrder).toHaveBeenCalledWith(undefined);
  });

  it("injects a contract-valid lightweight default sample by default", async () => {
    const { context, engine, setSceneInteractions } = fixture();
    const createScene = createSceneCreationAction(context, vi.fn(async () => undefined));

    await createScene("示例场景");

    const saved = savedScene();
    expect(saved.models).toEqual([]);
    expect(saved.primitives.map((primitive) => primitive.modelId)).toEqual([
      "sample-pedestal",
      "sample-pillar",
      "sample-status-beacon",
    ]);
    expect(saved.primitives.every((primitive) => primitive.name.startsWith("示例") && primitive.locked !== true)).toBe(true);
    expect(saved.primitives.find((primitive) => primitive.modelId === "sample-pedestal")?.material).toMatchObject({ roughness: 0.82, metalness: 0 });
    expect(saved.primitives.find((primitive) => primitive.modelId === "sample-pillar")?.material).toMatchObject({ roughness: 0.24, metalness: 0.72 });
    expect(saved.interactions?.[0]).toMatchObject({
      target: { kind: "object", modelId: "sample-status-beacon" },
      trigger: "click",
      actions: [
        { type: "focus", enabled: true },
        { type: "message", enabled: true },
      ],
    });
    expect(() => validateScene(sceneDocument(saved), "scene")).not.toThrow();
    expect(engine.createPrimitive).toHaveBeenCalledTimes(3);
    expect(engine.applyModelState).toHaveBeenCalledTimes(3);
    expect(engine.setInteractionScripts).toHaveBeenLastCalledWith(saved.interactions);
    expect(setSceneInteractions).toHaveBeenLastCalledWith(saved.interactions);
  });

  it("keeps the explicit blank creation path empty", async () => {
    const { context, engine } = fixture();
    const createScene = createSceneCreationAction(context, vi.fn(async () => undefined));

    await createScene("空白场景", { template: "blank" });

    const saved = savedScene();
    expect(saved.primitives).toEqual([]);
    expect(saved.interactions).toEqual([]);
    expect(saved.cameraViews).toEqual([]);
    expect(engine.createPrimitive).not.toHaveBeenCalled();
    expect(() => validateScene(sceneDocument(saved), "scene")).not.toThrow();
  });

  it("does not accumulate sample primitives across repeated creates", async () => {
    const { context } = fixture();
    const createScene = createSceneCreationAction(context, vi.fn(async () => undefined));

    await createScene("示例 A");
    await createScene("示例 B");

    const scenes = vi.mocked(api.saveScene).mock.calls.map(([scene]) => scene as SceneSnapshot);
    expect(scenes).toHaveLength(2);
    expect(scenes[0]!.primitives).toHaveLength(3);
    expect(scenes[1]!.primitives).toHaveLength(3);
    expect(scenes[1]!.primitives.map((primitive) => primitive.modelId)).toEqual([
      "sample-pedestal",
      "sample-pillar",
      "sample-status-beacon",
    ]);
  });
});

function fixture() {
  const noop = vi.fn();
  const setSelectedLightId = vi.fn();
  const setRootLayerOrder = vi.fn();
  const setSceneInteractions = vi.fn();
  const engine = new Proxy({
    clearSceneModels: vi.fn(),
    applyCamera: vi.fn(),
    createPrimitive: vi.fn(),
    applyModelState: vi.fn(),
    setInteractionScripts: vi.fn(),
  }, { get: (target, key) => key in target ? target[key as keyof typeof target] : noop });
  const base = {
    engine,
    project: { id: "project" },
    configuredDefaultEnvironment: { gridVisible: true, backgroundColor: "#000000", skybox: "studio" },
    sceneApplyVersionRef: { current: 0 },
    primitiveColors: { current: new Map() },
    sortScenesByTime: (items: unknown[]) => items,
    setSelectedLightId,
    setRootLayerOrder,
    setSceneInteractions,
  };
  const context = new Proxy(base, { get: (target, key) => key in target ? target[key as keyof typeof target] : noop }) as unknown as ScenePersistenceControllerContext;
  return { context, engine, setSelectedLightId, setRootLayerOrder, setSceneInteractions };
}

function savedScene(): SceneSnapshot {
  return vi.mocked(api.saveScene).mock.calls.at(-1)?.[0] as SceneSnapshot;
}

function sceneDocument(scene: SceneSnapshot) {
  const {
    schemaVersion: _schemaVersion,
    projectId: _projectId,
    dashboard: _dashboard,
    interactions: _interactions,
    publishedAt: _publishedAt,
    publicationMode: _publicationMode,
    publicationPerformance: _publicationPerformance,
    publicationToolbarVisible: _publicationToolbarVisible,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...document
  } = scene;
  return document;
}
