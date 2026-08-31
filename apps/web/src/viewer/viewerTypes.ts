import * as THREE from "three";
import type {
  CameraState,
  MeasurementState,
  SceneInteractionScriptState,
  SceneLightState,
  Vector3Value
} from "@bim-studio/contracts";

export type TransformMode = "translate" | "rotate" | "scale";
export type NavigationMode = CameraState["mode"];
export type MeasureMode = NonNullable<MeasurementState["kind"]>;
export type StandardView = "top" | "bottom" | "left" | "right" | "front" | "back";
export type SelectionScope = "model" | "component";
export type RendererBackend = "webgl" | "webgpu";

export interface RendererDeviceLossInfo {
  api: "WebGPU";
  message: string;
  reason: string | null;
}

export class ModelLoadSupersededError extends Error {
  constructor() {
    super("模型加载已被新的场景恢复任务替代");
    this.name = "ModelLoadSupersededError";
  }
}

export function shouldRenderSceneLightProxy(readOnly: boolean, type: SceneLightState["type"]): boolean {
  return !readOnly && type !== "ambient" && type !== "hemisphere";
}

export interface SceneStatistics {
  modelCount: number;
  primitiveCount: number;
  componentCount: number;
  triangleCount: number;
  vertexCount: number;
}

export interface NavigationCollisionDiagnostics {
  debugVisible: boolean;
  blockingObjectCount: number;
  raySamples: number;
  lastSweepMs: number;
}

export interface PointerInfo {
  screenX: number;
  screenY: number;
  world?: Vector3Value;
  objectName?: string;
}

export interface BimSpaceRecord {
  id: string;
  modelId: string;
  modelName: string;
  name: string;
  number?: string;
  level: string;
  kind: string;
  department?: string;
  areaSquareMetres?: number;
  volumeCubicMetres?: number;
  bounds?: { min: Vector3Value; max: Vector3Value };
  parameters?: BimPropertyEntry[];
  componentId?: string;
}

export interface BimPropertyEntry {
  name: string;
  value: string;
  group?: string;
}

export interface LayerTreeNode {
  id: string;
  modelId: string;
  name: string;
  type: string;
  visible: boolean;
  locked: boolean;
  deleted: boolean;
  children: LayerTreeNode[];
}

export interface LoadedSceneModel {
  id: string;
  name: string;
  object: THREE.Object3D;
  kind: "model" | "primitive";
  visible: boolean;
  opacity: number;
}

export interface InteractionScriptResult {
  script: SceneInteractionScriptState;
  status: "success" | "error";
  durationMs: number;
  test?: boolean;
  error?: unknown;
}

export interface InteractionEventDetail {
  originalEvent?: Event;
  point?: THREE.Vector3;
  object?: THREE.Object3D;
  payload?: unknown;
  test?: boolean;
}

export interface AnnotationPointerHit {
  annotationId: string;
  dismiss: boolean;
}
