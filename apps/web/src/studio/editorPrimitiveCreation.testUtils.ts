import * as THREE from "three";
import { vi } from "vitest";
import { ViewerEngine } from "../viewer/ViewerEngine";
import { modelInstanceHarness } from "../viewer/modelInstanceEngineTestFixture";
import { PrimitiveGeometryCache } from "../viewer/primitiveGeometry";
import { PrimitiveMaterialCache } from "../viewer/primitiveMaterial";
import { makeSceneSnapshot } from "../controllers/sceneSnapshotFactory";

/** Production creation/register/transform/material/snapshot/remove; renderer and UI adapters are isolated. */
export function primitiveCreationHarness() {
  const f = modelInstanceHarness(), engine = f.engine;
  const primitiveGeometryCache = new PrimitiveGeometryCache(), primitiveMaterialCache = new PrimitiveMaterialCache();
  const authorModelTransforms = new Map();
  Object.assign(engine, {
    primitiveGeometryCache, primitiveMaterialCache, authorModelTransforms, collisionOriginalMaterials: new Map(),
    registerObject: Reflect.get(ViewerEngine.prototype, "registerObject"),
    getModelTransform: ViewerEngine.prototype.getModelTransform, setModelTransform: ViewerEngine.prototype.setModelTransform,
    applyModelState: ViewerEngine.prototype.applyModelState,
    getModelColor: ViewerEngine.prototype.getModelColor, getMaterialState: Reflect.get(ViewerEngine.prototype, "getMaterialState"),
    captureModelBoneRestPose: vi.fn(), rebuildComponentIndex: vi.fn(), scheduleRendererPipelineWarmup: vi.fn(),
    syncFragmentsTransformState: vi.fn(), updateSelectionHelper: vi.fn(),
    isModelLocked: () => false, isCollisionEnabled: () => false, getExplosionFactor: () => 0, getExplosionMode: () => "radial",
    getIndustrialPrefabState: () => undefined, getSpatialAudioState: () => undefined, getModelEffects: () => undefined,
    getPhysicsBodyState: () => undefined, getModelRigState: () => undefined, getRobotPose: () => undefined,
    getModelColorOverride: () => undefined, getModelMaterialOverride: () => undefined,
    getCameraState: () => ({ mode: "orbit", position: { x: 0, y: 0, z: 8 }, target: { x: 0, y: 0, z: 0 } }),
    getCameraConstraints: () => undefined, getNavigationSettings: () => undefined, listAnnotations: () => [],
    getClippingState: () => ({ enabled: false }), getWeather: () => "sunny", getGlobalLighting: () => undefined,
    getSceneEnvironment: () => undefined, getPostProcessing: () => undefined, getSceneAnimation: () => undefined,
    setVisible: vi.fn(), setOpacity: vi.fn(), applyLayerStates: vi.fn(), setModelLocked: vi.fn(),
    setCollisionEnabled: vi.fn(), setSpatialAudioState: vi.fn(), setIndustrialPrefabState: vi.fn(),
  });
  const source = { engine, project: { id: "p", models: [] }, activeScene: { id: "s", createdAt: "" }, sceneName: "SDK",
    cameraViews: [], measurements: [], sceneDataBindings: [], sceneAssetBindings: [], sceneInteractions: [], selectionSets: [],
    primitiveColors: { current: new Map() } } as unknown as Parameters<typeof makeSceneSnapshot>[0];
  let revision = 0;
  const host = { sceneId: "s", viewer: () => engine, readRevision: () => revision, bumpRevision: () => { revision++; } };
  const cleanup = () => {
    for (const id of [...f.models.keys()]) engine.removeModel(id);
    primitiveGeometryCache.dispose(); primitiveMaterialCache.dispose();
  };
  return { ...f, host, authorModelTransforms, primitiveGeometryCache, primitiveMaterialCache,
    snapshot: () => makeSceneSnapshot(source)!, cleanup, mesh: (id: string) => f.models.get(id)!.object as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> };
}
