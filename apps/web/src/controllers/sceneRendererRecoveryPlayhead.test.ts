import { describe, expect, it, vi } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import pureFixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { ViewerSnapshotReadiness } from "../viewer/viewerSnapshotReadiness";
import { readAnimationPlayheadSec } from "../viewer/animationPlayheadReader";
import type { RendererRecoveryState } from "../viewer/rendererRecoveryState";
import { createScenePersistenceController } from "./scenePersistenceController";
import type { ScenePersistenceControllerContext } from "./scenePersistenceControllerContext";

/**
 * J3-E：渲染器重建类恢复（设备丢失 / WebGPU 回收 / 返回编辑器）的编辑器瞬时播放头。
 * SceneSnapshot 只含动画策略；播放头经 RendererRecoveryState.animationPlayheadSec
 * 与 applyScene 第 9 参往返，缺省 = 归零重放（旧调用方逐位不变）。
 */

function animationChannel(time: number | undefined) {
  return {
    transientChannels: {
      channel: (name: string) => name === "animation" && time !== undefined
        ? { snapshot: () => ({ time, playing: false }) }
        : undefined,
    },
  };
}

describe("readAnimationPlayheadSec", () => {
  it("reads the transient animation channel time", () => {
    expect(readAnimationPlayheadSec(animationChannel(12.5) as never)).toBe(12.5);
  });
  it("returns undefined for missing channel, zero, negative and non-finite values", () => {
    expect(readAnimationPlayheadSec(undefined)).toBeUndefined();
    expect(readAnimationPlayheadSec(animationChannel(undefined) as never)).toBeUndefined();
    expect(readAnimationPlayheadSec(animationChannel(0) as never)).toBeUndefined();
    expect(readAnimationPlayheadSec(animationChannel(-3) as never)).toBeUndefined();
    expect(readAnimationPlayheadSec(animationChannel(Number.NaN) as never)).toBeUndefined();
  });
  it("survives a throwing channel", () => {
    const engine = { transientChannels: { channel: () => { throw new Error("disposed"); } } };
    expect(readAnimationPlayheadSec(engine as never)).toBeUndefined();
  });
});

describe("applyScene restores the renderer-recovery playhead", () => {
  function persistenceFixture(playhead: number | undefined) {
    const scene = structuredClone(pureFixture) as SceneSnapshot;
    scene.models.push({ modelId: "gripper", name: "夹爪", visible: true, opacity: 1,
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } });
    const readiness = new ViewerSnapshotReadiness();
    readiness.begin(scene.id); readiness.complete(1);
    const seekCalls: number[] = [];
    const engine = {
      scene: { uuid: "viewer-1" },
      getAuthorRendererBackend: () => "webgl",
      isSceneSnapshotReady: (id: string) => readiness.ready(id, false, false),
      hasRestoredSceneSnapshot: (id: string) => readiness.ready(id, false, false),
      beginSceneSnapshotRestore: (id: string) => readiness.begin(id),
      completeSceneSnapshotRestore: (generation: number) => readiness.complete(generation),
      getPhysicsState: () => ({ enabled: false, playing: false, gravity: { x: 0, y: -9.81, z: 0 } }),
      setPhysicsState: vi.fn(), clearSceneModels: vi.fn(), setReadOnly: vi.fn(), setFastRuntime: vi.fn(),
      setInteractionScripts: vi.fn(), listModels: () => [{ id: "gripper", kind: "model" }],
      applyModelState: vi.fn(), rename: vi.fn(), clearMeasurements: vi.fn(), addMeasurementVisual: vi.fn(),
      addAnnotation: vi.fn(), listAnnotations: () => [], setCameraConstraints: vi.fn(),
      setNavigationSettings: vi.fn(), applyCamera: vi.fn(), setWeather: vi.fn(), setGlobalLighting: vi.fn(),
      setSceneEnvironment: vi.fn(), applyFloorStates: vi.fn(), setPostProcessing: vi.fn(),
      setSceneAnimation: vi.fn(), setClipping: vi.fn(), select: vi.fn(), selectAnnotation: vi.fn(),
      selectLayer: vi.fn(), requestRender: vi.fn(),
      seekSceneAnimation: (time: number) => { seekCalls.push(time); },
      ...animationChannel(playhead),
    };
    const context = {
      engine, project: { id: scene.projectId, models: [{ id: "gripper", status: "ready", manifest: {} }] },
      activeScene: scene, route: { view: "studio", projectId: scene.projectId, sceneId: scene.id }, locale: "zh-CN",
      sceneApplyVersionRef: { current: 1 }, lastAutoSavedSceneRevisionRef: { current: 0 },
      getActiveScene: () => scene, navigate: vi.fn(), setActiveScene: vi.fn(), setRevision: vi.fn(),
      isModelLoadSuperseded: (reason: unknown) => reason instanceof Error && reason.name === "ModelLoadSupersededError",
      primitiveColors: { current: new Map() }, configuredDefaultEnvironment: {},
      webGpuSceneReplacementCountRef: { current: 0 },
      loadModel: vi.fn(async () => ({ id: "gripper" })),
      showError: vi.fn(),
    } as unknown as ScenePersistenceControllerContext;
    for (const name of [
      "setSceneInteractions", "setSceneDataBindings", "setSceneAssetBindings", "setSceneDataBindingRuntime", "setSelected",
      "setMeasurements", "setAnnotations", "setSelectedAnnotationId", "setSelectedLightId", "setSelectedSpace",
      "setSceneOrganizationSelection", "setSelectionSets", "setLastDeletedSelectionSet", "setCameraConstraints",
      "setNavigationSettings", "setCameraViews", "setDefaultCameraViewId", "setWeather", "setLighting",
      "setSceneEnvironment", "setSceneCoordinates", "setSceneAnimation", "setPostProcessing", "setPhysics",
      "setSceneDashboard", "setEngineeringAnalysis", "setAnimationTime", "setAnimationPlaying", "setClippingState",
      "setNavigationMode", "setAvatarVisible", "setViewerLoadState", "setSceneName", "setMessage", "setBusy",
    ]) (context as unknown as Record<string, unknown>)[name] = vi.fn();
    return { scene, engine, context, persistence: createScenePersistenceController(context), seekCalls: () => seekCalls };
  }

  it("renderer-recovery path seeks the captured playhead after the zero-replay baseline", async () => {
    const f = persistenceFixture(12.5);
    await f.persistence.applyScene(structuredClone(f.scene), false, f.context.project, false, false, false, true, false, 12.5);
    expect(f.seekCalls()).toEqual([0, 12.5]);
    expect(f.context.setAnimationTime).toHaveBeenCalledWith(12.5);
    expect(f.context.setAnimationPlaying).toHaveBeenCalledWith(false);
    expect(f.engine.hasRestoredSceneSnapshot(f.scene.id)).toBe(true);
  });

  it("default restores keep the zero-replay semantics bitwise (undo/redo/import paths)", async () => {
    const f = persistenceFixture(12.5);
    await f.persistence.applyScene(structuredClone(f.scene), false, f.context.project, false, false, false, true);
    expect(f.seekCalls()).toEqual([0]);
    expect(f.context.setAnimationTime).toHaveBeenCalledWith(0);
  });

  it("zero, negative and non-finite recovery playheads are ignored as undefined", async () => {
    for (const value of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const f = persistenceFixture(12.5);
      await f.persistence.applyScene(structuredClone(f.scene), false, f.context.project, false, false, false, true, false, value);
      expect(f.seekCalls(), String(value)).toEqual([0]);
    }
  });
});

describe("WebGPU recycle recovery state carries the live playhead", () => {
  it("rendererSnapshotRef records the transient playhead beside the scene", async () => {
    const scene = structuredClone(pureFixture) as SceneSnapshot;
    const rendererSnapshotRef = { current: undefined as RendererRecoveryState | undefined };
    const engine = {
      getAuthorRendererBackend: () => "webgpu",
      getSceneStatistics: () => ({ componentCount: 6_000 }),
      ...animationChannel(7.25),
    };
    const context = {
      engine, project: { id: scene.projectId }, activeScene: scene,
      route: { view: "studio", projectId: scene.projectId, sceneId: scene.id },
      sceneApplyVersionRef: { current: 1 }, webGpuSceneReplacementCountRef: { current: 2 },
      rendererSnapshotRef, navigate: vi.fn(), setBusy: vi.fn(), setRendererSwitching: vi.fn(),
      setRendererGeneration: vi.fn(), showError: vi.fn(),
    } as unknown as ScenePersistenceControllerContext;
    const persistence = createScenePersistenceController(context);
    await persistence.applyScene(scene, false, context.project, false);
    expect(rendererSnapshotRef.current?.animationPlayheadSec).toBe(7.25);
    expect(rendererSnapshotRef.current?.scene.id).toBe(scene.id);
    expect(context.setRendererGeneration).toHaveBeenCalled();
  });
});
