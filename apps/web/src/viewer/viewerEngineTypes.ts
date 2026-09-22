import type { Group, Material, Mesh, Object3D, Vector3 } from "three";
import type { RigidBody } from "@dimforge/rapier3d-compat";
import type {
  CameraConstraintsState,
  ModelTransform,
  SceneLightState,
  SceneModelEffectsState
} from "@bim-studio/contracts";
import type { LayerTreeNode, RendererBackend } from "./viewerTypes";
import type { ModelFireEffectRuntime } from "./modelFireEffect";
import type { MountedRapierCharacter } from "./rapierCharacterController";

/** ViewerEngine 的内部运行类型与默认值，和渲染生命周期分离，便于单独审查。 */
export interface RendererInfoLike {
  render?: { calls?: number; drawCalls?: number; triangles?: number; points?: number; lines?: number };
  memory?: { geometries?: number; textures?: number };
  programs?: readonly unknown[];
}

/** 统一 WebGL/WebGPU 的本帧绘制计数，避免把 WebGPU 累计 render 调用误当成 draw call。 */
export function normalizedRendererDrawCalls(backend: RendererBackend, render: RendererInfoLike["render"]): number {
  if (!render) return 0;
  return backend === "webgpu" ? render.drawCalls ?? render.calls ?? 0 : render.calls ?? render.drawCalls ?? 0;
}

export const DEFAULT_SCENE_LIGHTS: SceneLightState[] = [
  { id: "sun-default", name: "主方向光", type: "directional", enabled: true, color: "#ffffff", intensity: 2.2, position: { x: 18, y: 28, z: 12 }, target: { x: 0, y: 0, z: 0 }, castShadow: true }
];

export const DEFAULT_CAMERA_CONSTRAINTS: CameraConstraintsState = {
  minDistance: 0.5,
  maxDistance: 10_000,
  minPolarAngle: 1,
  maxPolarAngle: 179,
  nearClip: 0.05,
  farClip: 100_000,
  collisionEnabled: true,
  collisionRadius: 0.32
};

export interface FragmentLayerEntry {
  node: LayerTreeNode;
  localIds: number[];
  localId?: number;
  properties: Record<string, string>;
}

export interface PointerSceneHit {
  point: Vector3;
  distance: number;
  objectName: string;
  object?: Object3D;
  normal?: Vector3;
  modelId?: string;
  fragmentNodeId?: string;
}

export interface NavigationViewState { position: Vector3; target: Vector3; }

export interface PhysicsBodyRuntime {
  body: RigidBody;
  initialTransform: ModelTransform;
  /** 仅 kinematic 刚体挂角色控制器；fixed/dynamic 恒为 undefined。 */
  character?: MountedRapierCharacter;
  /** B3-c：主碰撞体句柄，碰撞事件按它反查场景对象；移除 body 时同步注销。 */
  colliderHandle: number;
}

export interface ModelEffectRuntime {
  originals: Map<Mesh, Material | Material[]>;
  generated: Material[];
  helper?: Group;
  scan?: { mesh: Mesh; minY: number; maxY: number; phase: number };
  fire?: ModelFireEffectRuntime;
}

export type MaterialTextureSlot = "map" | "normalMap" | "emissiveMap" | "aoMap" | "roughnessMap" | "metalnessMap";
export type MaterialTextureMetadataKey = "studioBaseColorMapUrl" | "studioNormalMapUrl" | "studioEmissiveMapUrl" | "studioAmbientOcclusionMapUrl" | "studioRoughnessMapUrl" | "studioMetalnessMapUrl";

export const DEFAULT_MODEL_EFFECTS: SceneModelEffectsState = {
  outline: false,
  glow: false,
  xray: false,
  scanline: false,
  heatmap: false,
  dissolve: 0,
  edgeLight: false,
  color: "#36a3ff",
  intensity: 1
};

export const finiteCameraNumber = (value: number, fallback: number): number => Number.isFinite(value) ? value : fallback;
