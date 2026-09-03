import { describe, expect, it, vi } from "vitest";
import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { applySceneViewerSnapshot } from "./applySceneViewerSnapshot";

describe("applySceneViewerSnapshot", () => {
  it("restores primitives in snapshot order while yielding between time slices", async () => {
    const events: string[] = [];
    const engine = engineFixture({
      createPrimitive: vi.fn((id: string) => { events.push(`create:${id}`); }),
      applyModelState: vi.fn((id: string) => { events.push(`apply:${id}`); }),
    });
    const checkpoint = vi.fn()
      .mockImplementationOnce(async () => { events.push("checkpoint:1"); return false; })
      .mockImplementationOnce(async () => { events.push("checkpoint:2"); return true; });

    await applySceneViewerSnapshot(engine, sceneFixture(), projectFixture(), {
      primitiveScheduler: { checkpoint },
    });

    expect(events).toEqual([
      "create:primitive-1",
      "apply:primitive-1",
      "checkpoint:1",
      "create:primitive-2",
      "apply:primitive-2",
      "checkpoint:2",
    ]);
    expect(checkpoint).toHaveBeenCalledTimes(2);
    expect(engine.applyCamera).toHaveBeenCalledOnce();
  });

  it("stops after a yielded slice when the published viewer was cancelled", async () => {
    let cancelled = false;
    const engine = engineFixture();
    const checkpoint = vi.fn(async () => {
      cancelled = true;
      return true;
    });

    await applySceneViewerSnapshot(engine, sceneFixture(), projectFixture(), {
      isCancelled: () => cancelled,
      primitiveScheduler: { checkpoint },
    });

    expect(engine.createPrimitive).toHaveBeenCalledTimes(1);
    expect(engine.createPrimitive).toHaveBeenCalledWith("primitive-1", "基础元素 1", "box", "#1683ff");
    expect(engine.addMeasurementVisual).not.toHaveBeenCalled();
    expect(engine.applyCamera).not.toHaveBeenCalled();
  });

  it("propagates restore failures without continuing to later scene state", async () => {
    const failure = new Error("primitive restore failed");
    const engine = engineFixture({
      createPrimitive: vi.fn(() => { throw failure; }),
    });

    await expect(applySceneViewerSnapshot(engine, sceneFixture(), projectFixture(), {
      primitiveScheduler: { checkpoint: vi.fn(async () => false) },
    })).rejects.toBe(failure);

    expect(engine.applyModelState).not.toHaveBeenCalled();
    expect(engine.applyCamera).not.toHaveBeenCalled();
  });
});

function sceneFixture(): SceneSnapshot {
  return {
    schemaVersion: 1,
    id: "scene-1",
    projectId: "project-1",
    name: "发布场景",
    camera: {
      position: { x: 4, y: 3, z: 2 },
      target: { x: 0, y: 0, z: 0 },
      mode: "orbit",
    },
    models: [],
    primitives: [
      primitive("primitive-1", "基础元素 1", "#1683ff"),
      primitive("primitive-2", "基础元素 2", "#22a06b"),
    ],
    measurements: [],
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
}

function primitive(modelId: string, name: string, color: string): SceneSnapshot["primitives"][number] {
  return {
    modelId,
    name,
    kind: "box",
    color,
    visible: true,
    opacity: 1,
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
  };
}

function projectFixture(): ProjectRecord {
  return {
    id: "project-1",
    name: "测试项目",
    description: "",
    models: [],
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
}

function engineFixture(overrides: Record<string, unknown> = {}): ViewerEngine {
  return {
    setReadOnly: vi.fn(),
    setFastRuntime: vi.fn(),
    clearSceneModels: vi.fn(),
    setInteractionScripts: vi.fn(),
    loadManifest: vi.fn(),
    applyModelState: vi.fn(),
    rename: vi.fn(),
    createPrimitive: vi.fn(),
    clearMeasurements: vi.fn(),
    addMeasurementVisual: vi.fn(),
    addAnnotation: vi.fn(),
    setCameraConstraints: vi.fn(),
    setNavigationSettings: vi.fn(),
    applyCamera: vi.fn(),
    setWeather: vi.fn(),
    setGlobalLighting: vi.fn(),
    setSceneEnvironment: vi.fn(),
    applyFloorStates: vi.fn(),
    setPostProcessing: vi.fn(),
    setPhysicsState: vi.fn(),
    setSceneAnimation: vi.fn(),
    seekSceneAnimation: vi.fn(),
    setClipping: vi.fn(),
    selectAnnotation: vi.fn(),
    selectLayer: vi.fn(),
    select: vi.fn(),
    ...overrides,
  } as unknown as ViewerEngine;
}
