import * as THREE from "three";
import { vi } from "vitest";
import type { ModelManifest, SceneFloorState, SceneModelState } from "@bim-studio/contracts";
import { ViewerEngine } from "./ViewerEngine";
import { ModelLoadCoordinator } from "./modelLoadCoordinator";
import type { LoadedSceneModel } from "./viewerTypes";
import { disposeViewerObject } from "./sceneOverlayVisuals";

export function manifest(id = "asset-new"): ModelManifest {
  return { schemaVersion: 1, modelId: id, sourceName: `${id}.glb`, sourceFormat: "glb", viewerKind: "gltf", geometryUrl: `/${id}.glb`, createdAt: "now" };
}

export function modelObject(partName = "part") {
  const root = new THREE.Group();
  const part = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  part.name = partName;
  root.add(part);
  return root;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

/** 只隔离渲染器/IO适配器；加载协调、候选校验与状态捕获使用生产实现。 */
export function modelInstanceHarness() {
  const engine = Object.create(ViewerEngine.prototype) as ViewerEngine;
  const models = new Map<string, LoadedSceneModel>();
  const floors = new Map<string, SceneFloorState>();
  const applied = new Map<string, SceneModelState>();
  const controls = { locked: false, isolated: false, selected: "instance", selectedLayer: "root/0" as string | undefined };
  const original: LoadedSceneModel = { id: "instance", assetModelId: "asset-old", name: "作者命名", object: modelObject(), kind: "model", visible: false, opacity: 0.45 };
  original.object.position.set(7, 2, 3);
  original.object.rotation.set(0.2, 0.3, 0.1);
  original.object.scale.set(2, 3, 4);
  models.set(original.id, original);
  const state = {
    material: { roughness: 0.3, metalness: 0.7 }, rig: { bones: [], ik: [] },
    spatialAudio: { enabled: false, url: "/audio.ogg", autoplay: false, loopMode: "once", muted: true, volume: 0.2, refDistance: 1, maxDistance: 30, rolloffFactor: 1 },
    effects: { outline: true, glow: false, xray: false, scanline: false, heatmap: false, dissolve: 0, edgeLight: false, color: "#ffffff", intensity: 1 },
    physics: { type: "fixed", mass: 2, friction: 0.4, restitution: 0.1 },
    layers: [{ nodeId: "root/0", visible: false, opacity: 0.6 }],
  };
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(12, 8, 11);
  const gltfLoader = { loadAsync: vi.fn(async (_url: string) => ({ scene: modelObject(), animations: [] as THREE.AnimationClip[] })) };
  const modelLoads = new ModelLoadCoordinator<LoadedSceneModel>();
  const animationClips = new Map<string, THREE.AnimationClip[]>();
  const disposeObject = vi.fn(disposeViewerObject);
  const fitAll = vi.fn();
  const modelRoot = new THREE.Group(); modelRoot.add(original.object);
  const removeModel = vi.fn((id: string) => ViewerEngine.prototype.removeModel.call(engine, id));
  const registerObject = vi.fn((id: string, name: string, object: THREE.Object3D) => {
    const loaded: LoadedSceneModel = { id, name, object, kind: "model", visible: true, opacity: 1 };
    modelRoot.add(object);
    models.set(id, loaded);
    return loaded;
  });
  const applyModelState = vi.fn((id: string, saved: SceneModelState) => {
    applied.set(id, structuredClone(saved));
    const loaded = models.get(id)!;
    loaded.visible = saved.visible; loaded.opacity = saved.opacity;
    const { position, rotation, scale } = saved.transform;
    loaded.object.position.set(position.x, position.y, position.z);
    loaded.object.rotation.set(rotation.x, rotation.y, rotation.z);
    loaded.object.scale.set(scale.x, scale.y, scale.z);
  });
  Object.assign(engine, {
    models, modelRoot, modelLoads, gltfLoader, animationClips, camera, readOnlyMode: false,
    fragmentModels: new Map(), mixers: new Map(), animationClipSelection: new Map(), animationEnabledIds: new Set(),
    modelAnimationPlaybackStates: new Map(), floorStates: floors, spaceVisuals: new Map(),
    physicsBodyStates: new Map(), modelEffectRuntimes: new Map(), modelEffects: new Map(), spatialAudioStates: new Map(),
    layerObjects: new Map(), layerStates: new Map(), componentRecords: new Map(), modelColorOverrides: new Map(),
    modelMaterialOverrides: new Map(), modelRigStates: new Map(), modelBoneRestRotations: new Map(), modelPrefabStates: new Map(),
    motionRouteRuntimes: new Map(), explosionPositions: new Map(), explosionFactors: new Map(), explosionModes: new Map(),
    collisionEnabledIds: new Set(), collidingIds: new Set(),
    removePhysicsBody: vi.fn(), restoreModelEffectMaterials: vi.fn(), clearIsolation: vi.fn(), setExplosion: vi.fn(),
    setCollisionHighlight: vi.fn(), disposeSpatialAudioRuntime: vi.fn(), updateCollisions: vi.fn(), markShadowMapDirty: vi.fn(), onModelChange: vi.fn(),
    disposeObject, fitAll, removeModel, registerObject, applyModelState, dispatchObjectLifecycle: vi.fn(),
    isModelLocked: () => controls.locked, isIsolationActive: () => controls.isolated,
    getSelected: () => models.get(controls.selected), getSelectedLayerId: () => controls.selectedLayer,
    select: (id?: string) => { controls.selected = id ?? ""; controls.selectedLayer = undefined; },
    selectLayer: (id: string, layerId: string) => { controls.selected = id; controls.selectedLayer = layerId; },
    getFloorStates: () => [...floors.values()].map(floor => structuredClone(floor)),
    setFloorState: (id: string, level: string, visible: boolean, expansion: number) => floors.set(`${id}:${level}`, { modelId: id, level, visible, expansion }),
    getModelTransform: (id: string) => {
      const object = models.get(id)?.object;
      if (!object) return;
      const { position, rotation, scale } = object;
      return { position: { x: position.x, y: position.y, z: position.z }, rotation: { x: rotation.x, y: rotation.y, z: rotation.z }, scale: { x: scale.x, y: scale.y, z: scale.z } };
    },
    getModelColorOverride: () => "#9ba1a9", getModelMaterialOverride: () => state.material,
    getModelRigState: () => state.rig, getIndustrialPrefabState: () => undefined,
    getSpatialAudioState: () => state.spatialAudio, getModelEffects: () => state.effects,
    getPhysicsBodyState: () => state.physics, getLayerStates: () => state.layers,
    isCollisionEnabled: () => true, getExplosionFactor: () => 0.6, getExplosionMode: () => "vertical",
    hasAnimation: (id: string) => (animationClips.get(id)?.length ?? 0) > 0,
    isAnimationEnabled: () => false, getModelAnimationPlaybackState: () => ({ autoplay: false, loopMode: "once" }),
  });
  Object.defineProperty(engine, "selectedId", { get: () => controls.selected || undefined, configurable: true });
  return { engine, models, modelRoot, floors, applied, controls, original, state, camera, modelLoads, gltfLoader, disposeObject, removeModel, fitAll, animationClips, registerObject, applyModelState };
}
