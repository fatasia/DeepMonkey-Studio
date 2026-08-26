import { describe, expect, it, vi } from "vitest";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { createStudioViewerAPI } from "./studioApi";

describe("createStudioViewerAPI", () => {
  it("provides stable ThingJS-style object and camera handles backed by ViewerEngine", () => {
    const setModelTransform = vi.fn();
    const setColor = vi.fn();
    const setCameraPose = vi.fn();
    const setNavigationMode = vi.fn();
    const engine = {
      listModels: () => [{ id: "agv-01", name: "AGV 01", kind: "model", visible: true, opacity: 1, object: {} }],
      getModelTransform: () => ({ position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }),
      getRawObject: () => ({}), getRawScene: () => ({}), getRawCamera: () => ({}), getRawRenderer: () => ({}),
      setModelTransform, setColor, setCameraPose, setNavigationMode
    } as unknown as ViewerEngine;
    const studio = createStudioViewerAPI(engine, { sceneId: "scene:factory" });

    const agv = studio.object("AGV 01");
    expect(agv?.position).toEqual([1, 2, 3]);
    agv?.setPosition(10, 0, 20);
    agv?.setColor("#22c55e");
    studio.camera.setPose([8, 4, 8], [0, 0, 0], { far: 50_000 });
    studio.camera.setMode("firstPerson");

    expect(setModelTransform).toHaveBeenCalledWith("agv-01", { position: [10, 0, 20] });
    expect(setColor).toHaveBeenCalledWith("agv-01", "#22c55e");
    expect(setCameraPose).toHaveBeenCalledWith({ position: [8, 4, 8], target: [0, 0, 0], far: 50_000 });
    expect(setNavigationMode).toHaveBeenCalledWith("firstPerson");
  });

  it("emits portable application actions when no viewer runtime is loaded", () => {
    const emitAction = vi.fn();
    const studio = createStudioViewerAPI(undefined, { sceneId: "scene:factory", emitAction });
    studio.camera.applyView("camera:overview");
    studio.scene.open("scene:line", false);

    expect(emitAction).toHaveBeenNthCalledWith(1, { type: "cameraView", cameraViewId: "camera:overview", sceneId: "scene:factory" });
    expect(emitAction).toHaveBeenNthCalledWith(2, { type: "navigateScene", sceneId: "scene:line", newTab: false });
  });
});
