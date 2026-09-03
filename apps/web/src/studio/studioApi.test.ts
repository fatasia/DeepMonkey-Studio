import { describe, expect, it, vi } from "vitest";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { createStudioViewerAPI } from "./studioApi";

describe("createStudioViewerAPI", () => {
  it("provides stable object and camera handles backed by ViewerEngine", () => {
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

  it("controls model screen media through the same persisted material state", () => {
    const setModelMaterial = vi.fn();
    const current = {
      enabled: true, sourceType: "video" as const, url: "/screens/old.mp4", autoplay: true,
      loopMode: "loop" as const, muted: true, emissiveIntensity: 1,
    };
    const engine = {
      listModels: () => [{ id: "screen-01", name: "生产看板", kind: "model", visible: true, opacity: 1, object: {} }],
      getModelTransform: () => ({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }),
      getModelMaterialOverride: () => ({ screen: current }),
      setModelMaterial,
      getRawScene: () => ({}), getRawCamera: () => ({}), getRawRenderer: () => ({}), getRawObject: () => ({}),
    } as unknown as ViewerEngine;
    const screen = createStudioViewerAPI(engine).object("screen-01");

    screen?.setScreenMedia("/screens/new.mp4", { loopMode: "once", emissiveIntensity: 1.5 });
    screen?.pauseScreen();
    screen?.hideScreen();

    expect(setModelMaterial).toHaveBeenNthCalledWith(1, "screen-01", { screen: { ...current, url: "/screens/new.mp4", loopMode: "once", emissiveIntensity: 1.5 } });
    expect(setModelMaterial).toHaveBeenNthCalledWith(2, "screen-01", { screen: { ...current, autoplay: false } });
    expect(setModelMaterial).toHaveBeenNthCalledWith(3, "screen-01", { screen: { ...current, enabled: false, autoplay: false } });
  });

  it("reads and updates the current model PBR material through the script handle", () => {
    const setModelMaterial = vi.fn();
    const material = { color: "#d4a84f", roughness: 0.6, metalness: 0.2 };
    const engine = {
      listModels: () => [{ id: "pump-01", name: "循环水泵", kind: "model", visible: true, opacity: 1, object: {} }],
      getModelTransform: () => ({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }),
      getModelMaterialState: () => material,
      setModelMaterial,
      getRawScene: () => ({}), getRawCamera: () => ({}), getRawRenderer: () => ({}), getRawObject: () => ({}),
    } as unknown as ViewerEngine;
    const pump = createStudioViewerAPI(engine).object("pump-01");

    expect(pump?.getMaterial()).toEqual(material);
    pump?.setMaterial({ roughness: 0.25, metalness: 0.8, textureRepeatX: 2 });

    expect(setModelMaterial).toHaveBeenCalledWith("pump-01", { roughness: 0.25, metalness: 0.8, textureRepeatX: 2 });
  });

  it("lets a scene script drive fire visibility and intensity without losing authored settings", () => {
    const setModelEffects = vi.fn();
    const current = {
      outline: false, glow: false, xray: false, scanline: false, heatmap: false,
      dissolve: 0, edgeLight: false, color: "#36a3ff", intensity: 1,
      fire: { enabled: false, color: "#ff6a22", intensity: 1.5, height: 4, density: 1.2 },
    };
    const engine = {
      listModels: () => [{ id: "tank-01", name: "储罐", kind: "model", visible: true, opacity: 1, object: {} }],
      getModelTransform: () => ({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }),
      getModelEffects: () => current,
      setModelEffects,
      getRawScene: () => ({}), getRawCamera: () => ({}), getRawRenderer: () => ({}), getRawObject: () => ({}),
    } as unknown as ViewerEngine;

    createStudioViewerAPI(engine).object("tank-01")?.setFire(true, { intensity: 3.2 });

    expect(setModelEffects).toHaveBeenCalledWith("tank-01", {
      ...current,
      fire: { ...current.fire, enabled: true, intensity: 3.2 },
    });
  });

  it("configures and controls persisted positional audio", () => {
    const setSpatialAudioState = vi.fn();
    const controlSpatialAudio = vi.fn();
    const engine = {
      listModels: () => [{ id: "motor-01", name: "主电机", kind: "model", visible: true, opacity: 1, object: {} }],
      getModelTransform: () => ({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }),
      getSpatialAudioState: () => undefined,
      setSpatialAudioState,
      controlSpatialAudio,
      getRawScene: () => ({}), getRawCamera: () => ({}), getRawRenderer: () => ({}), getRawObject: () => ({}),
    } as unknown as ViewerEngine;
    const motor = createStudioViewerAPI(engine).object("motor-01");

    motor?.setSpatialAudio("/audio/motor.ogg", { loopMode: "once", volume: 0.5, refDistance: 3 });
    motor?.playSpatialAudio();
    motor?.pauseSpatialAudio();
    motor?.replaySpatialAudio();
    motor?.stopSpatialAudio();

    expect(setSpatialAudioState).toHaveBeenCalledWith("motor-01", {
      enabled: true,
      url: "/audio/motor.ogg",
      autoplay: true,
      loopMode: "once",
      muted: false,
      volume: 0.5,
      refDistance: 3,
      maxDistance: 50,
      rolloffFactor: 1,
    });
    expect(controlSpatialAudio.mock.calls).toEqual([
      ["motor-01", "play"], ["motor-01", "pause"], ["motor-01", "replay"], ["motor-01", "stop"],
    ]);
  });
});
