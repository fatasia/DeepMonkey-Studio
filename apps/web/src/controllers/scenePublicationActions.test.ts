import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import type { ScenePersistenceControllerContext } from "./scenePersistenceControllerContext";
import { createScenePublicationActions } from "./scenePublicationActions";

const apiMocks = vi.hoisted(() => ({ saveScene: vi.fn(), publishScene: vi.fn() }));

vi.mock("../api", () => ({ api: apiMocks }));

const scene: SceneSnapshot = {
  schemaVersion: 1,
  id: "scene-1",
  projectId: "project-1",
  name: "装配线",
  camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
  models: [],
  primitives: [],
  measurements: [],
  dataBindings: [],
  interactions: [],
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
};

describe("scene publication actions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("saves publication settings before publishing and closes only after success", async () => {
    const setMessage = vi.fn();
    const setStudioPublishOpen = vi.fn();
    const setScenes = vi.fn();
    const setActiveScene = vi.fn();
    const saveCurrentScene = vi.fn().mockResolvedValue(scene);
    const configured = { ...scene, publicationMode: "webgpu-preferred" as const, publicationPerformance: "fast" as const, publicationToolbarVisible: false };
    const published = { ...configured, publishedAt: "2026-08-31T08:00:00.000Z" };
    apiMocks.saveScene.mockResolvedValue(configured);
    apiMocks.publishScene.mockResolvedValue({ snapshot: published });
    const actions = createScenePublicationActions(
      {
        project: { id: "project-1" },
        activeScene: scene,
        route: { view: "studio", sceneId: scene.id },
        locale: "zh-CN",
        studioPublishMode: "webgl",
        studioPublishPerformance: "standard",
        enablePublishedCloudScene: vi.fn(),
        navigate: vi.fn(),
        sortScenesByTime: (items: SceneSnapshot[]) => items,
        showError: vi.fn(),
        setActiveScene,
        setMessage,
        setSceneName: vi.fn(),
        setScenes,
        setStudioPublishOpen,
      } as unknown as ScenePersistenceControllerContext,
      saveCurrentScene,
    );

    await actions.publishActiveScene("webgpu-preferred", "fast", false);

    expect(saveCurrentScene).toHaveBeenCalledOnce();
    expect(apiMocks.saveScene).toHaveBeenCalledWith(expect.objectContaining({ publicationMode: "webgpu-preferred", publicationPerformance: "fast", publicationToolbarVisible: false }));
    expect(apiMocks.publishScene).toHaveBeenCalledWith("project-1", scene.id);
    expect(setActiveScene).toHaveBeenCalledWith(published);
    expect(setScenes).toHaveBeenCalledOnce();
    expect(setStudioPublishOpen).toHaveBeenCalledWith(false);
    expect(setMessage).toHaveBeenCalledWith(expect.stringContaining("WebGPU"));
  });
});
