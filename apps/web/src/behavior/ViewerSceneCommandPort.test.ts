import { describe, expect, it, vi } from "vitest";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { SceneCommandExecutor } from "./SceneCommandExecutor";
import { ViewerSceneCommandPort } from "./ViewerSceneCommandPort";

describe("ViewerSceneCommandPort", () => {
  it("applies supported object, camera, and data commands through public viewer methods", async () => {
    const viewer = fakeViewer();
    const executor = new SceneCommandExecutor("scene-1", new ViewerSceneCommandPort(viewer));
    const results = await executor.execute([
      { id: "visible", type: "object.set-visibility", target: objectRef(), visible: false },
      { id: "move", type: "object.set-transform", target: objectRef(), position: [1, 2, 3] },
      { id: "camera", type: "camera.set", sceneId: "scene-1", position: [2, 3, 4], target: [0, 0, 0], near: 0.1, far: 1000 },
      { id: "data", type: "data.apply", target: objectRef(), values: { color: "#ff0000", ignored: 1 }, timestamp: "2026-08-25T00:00:00.000Z" }
    ]);

    expect(results.every((result) => result.success)).toBe(true);
    expect(viewer.setVisible).toHaveBeenCalledWith("robot", false);
    expect(viewer.setModelTransform).toHaveBeenCalledWith("robot", { position: [1, 2, 3] });
    expect(viewer.setCameraPose).toHaveBeenCalledWith(expect.objectContaining({ near: 0.1, far: 1000 }));
    expect(viewer.applySceneDataMessage).toHaveBeenCalledTimes(1);
  });

  it("reports unsupported precision instead of pretending advanced operations succeeded", async () => {
    const viewer = fakeViewer();
    const executor = new SceneCommandExecutor("scene-1", new ViewerSceneCommandPort(viewer));
    const results = await executor.execute([
      { id: "multi", type: "selection.set", targets: [objectRef(), { ...objectRef(), objectId: "robot-2" }] },
      { id: "fly", type: "camera.fly-to", sceneId: "scene-1", target: objectRef(), durationMs: 800 },
      { id: "seek", type: "animation.control", target: objectRef(), action: "seek", time: 1 }
    ]);

    expect(results).toEqual([
      expect.objectContaining({ id: "multi", success: false, code: "unsupported" }),
      expect.objectContaining({ id: "fly", success: false, code: "unsupported" }),
      expect.objectContaining({ id: "seek", success: false, code: "unsupported" })
    ]);
  });

  it("rejects commands targeting a model that is not loaded", async () => {
    const viewer = fakeViewer();
    const executor = new SceneCommandExecutor("scene-1", new ViewerSceneCommandPort(viewer));
    const missing = { ...objectRef(), objectId: "missing" };
    const results = await executor.execute([
      { id: "visible", type: "object.set-visibility", target: missing, visible: false },
      { id: "selection", type: "selection.set", targets: [missing] },
      { id: "data", type: "data.apply", target: missing, values: { color: "#ff0000" }, timestamp: "2026-08-25T00:00:00.000Z" }
    ]);

    expect(results).toEqual([
      expect.objectContaining({ id: "visible", success: false, code: "unsupported" }),
      expect.objectContaining({ id: "selection", success: false, code: "unsupported" }),
      expect.objectContaining({ id: "data", success: false, code: "unsupported" })
    ]);
    expect(viewer.setVisible).not.toHaveBeenCalled();
    expect(viewer.select).not.toHaveBeenCalled();
    expect(viewer.applySceneDataMessage).not.toHaveBeenCalled();
  });
});

function objectRef() {
  return { kind: "object" as const, sceneId: "scene-1", objectId: "robot" };
}

function fakeViewer(): ViewerEngine & Record<string, ReturnType<typeof vi.fn>> {
  return {
    listModels: vi.fn(() => [{ id: "robot" }]),
    setVisible: vi.fn(),
    setLayerVisible: vi.fn(),
    setModelTransform: vi.fn(() => true),
    select: vi.fn(),
    selectLayer: vi.fn(),
    setCameraPose: vi.fn(),
    getCameraState: vi.fn(() => ({ position: { x: 0, y: 2, z: 4 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" })),
    fitAll: vi.fn(),
    focusModel: vi.fn(() => true),
    hasAnimation: vi.fn(() => true),
    setAnimationEnabled: vi.fn(),
    applySceneDataMessage: vi.fn(() => true)
  } as unknown as ViewerEngine & Record<string, ReturnType<typeof vi.fn>>;
}
