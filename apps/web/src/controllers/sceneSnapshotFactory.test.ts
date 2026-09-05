import { describe, expect, it } from "vitest";
import type { ScenePersistenceControllerContext } from "./scenePersistenceControllerContext";
import type { SimulationEntityState } from "@bim-studio/contracts";
import { makeSceneSnapshot } from "./sceneSnapshotFactory";

describe("scene snapshot factory", () => {
  it("collects model, primitive and publication state without changing the editor", () => {
    const primitiveColors = { current: new Map([["marker-1", "#11aa77"]]) };
    const simulationEntities: SimulationEntityState[] = [{ id: "path-1", kind: "path", name: "送料路线", targetModelId: "marker-1", points: [[0, 0, 0], [3, 0, 0]], speed: 1, loopMode: "once" }];
    const engine = {
      listModels: () => [
        { id: "pump-1", kind: "model", name: "泵", visible: true, opacity: 0.85 },
        { id: "marker-1", kind: "primitive", name: "标记", visible: true, opacity: 1 },
      ],
      getCameraState: () => ({ position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" as const }),
      getCameraConstraints: () => ({ minDistance: 1, maxDistance: 20 }),
      getNavigationSettings: () => ({ walkSpeed: 3 }),
      getModelTransform: () => ({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }),
      getModelColorOverride: () => "#ffffff",
      getModelMaterialOverride: () => ({ baseColor: "#123456", roughness: 0.4 }),
      getModelRigState: () => undefined,
      getIndustrialPrefabState: () => undefined,
      getSpatialAudioState: () => undefined,
      isModelLocked: () => false,
      getModelEffects: () => [],
      getPhysicsBodyState: () => undefined,
      isCollisionEnabled: () => false,
      getExplosionFactor: () => 0,
      getExplosionMode: () => "radial" as const,
      hasAnimation: () => false,
      getLayerStates: () => [],
      primitiveState: (id: string, color: string) => ({ modelId: id, name: "标记", kind: "box" as const, color, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }),
      listAnnotations: () => [],
      getClippingState: () => ({ enabled: false }),
      getWeather: () => "sunny" as const,
      getGlobalLighting: () => ({ lights: [] }),
      getSceneEnvironment: () => ({ type: "color" as const, color: "#101010" }),
      getFloorStates: () => [],
      getPostProcessing: () => ({ enabled: false }),
      getPhysicsState: () => ({ enabled: false }),
      getSceneAnimation: () => ({ duration: 0, loop: false, camera: [], models: [] }),
    };
    const snapshot = makeSceneSnapshot({
      engine,
      project: { id: "project-1", name: "工厂", description: "", models: [{ id: "pump-1", name: "pump.glb", format: "glb" }], createdAt: "2026-08-31", updatedAt: "2026-08-31" },
      activeScene: { id: "scene-1", simulationEntities, thumbnail: "data:image/jpeg;base64,previous", publicationToolbarVisible: false, publishedAt: "2026-08-31T00:00:00.000Z", publicationMode: "webgl", publicationPerformance: "standard", createdAt: "2026-08-30T00:00:00.000Z" },
      sceneName: "  装配线  ",
      sceneCoordinates: { upAxis: "Y", unit: "meter" },
      cameraViews: [],
      defaultCameraViewId: undefined,
      measurements: [],
      sceneDashboard: { version: 1, widgets: [] },
      sceneDataBindings: [],
      sceneAssetBindings: [],
      sceneInteractions: [],
      selectionSets: [],
      selected: undefined,
      selectedLayerId: undefined,
      selectedAnnotationId: undefined,
      primitiveColors,
    } as unknown as ScenePersistenceControllerContext);

    expect(snapshot).toMatchObject({ id: "scene-1", name: "装配线", publishedAt: "2026-08-31T00:00:00.000Z" });
    expect(snapshot?.models[0]).toMatchObject({ modelId: "pump-1", sourceName: "pump.glb", material: { roughness: 0.4 } });
    expect(snapshot?.primitives[0]).toMatchObject({ modelId: "marker-1", color: "#11aa77" });
    expect(snapshot?.simulationEntities).toEqual(simulationEntities);
    expect(snapshot?.simulationEntities).not.toBe(simulationEntities);
    expect(snapshot?.thumbnail).toBe("data:image/jpeg;base64,previous");
    expect(snapshot?.publicationToolbarVisible).toBe(false);
  });
});
