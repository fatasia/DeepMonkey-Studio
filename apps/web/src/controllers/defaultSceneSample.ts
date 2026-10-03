import type { CameraState, CameraViewState, PrimitiveState, SceneInteractionScriptState } from "@bim-studio/contracts";

export type SceneCreationTemplate = "sample" | "blank";

export interface SceneCreationOptions {
  template?: SceneCreationTemplate;
}

interface DefaultSceneSampleContent {
  camera: CameraState;
  cameraViews: CameraViewState[];
  defaultCameraViewId: string;
  primitives: PrimitiveState[];
  interactions: SceneInteractionScriptState[];
}

const SAMPLE_CAMERA_VIEW_ID = "sample-overview";
const SAMPLE_BEHAVIOR_TARGET_ID = "sample-status-beacon";

const SAMPLE_CAMERA: CameraState = {
  position: { x: 7.5, y: 5.2, z: 7.5 },
  target: { x: 0, y: 0.9, z: 0 },
  mode: "orbit",
};

const SAMPLE_PRIMITIVES: PrimitiveState[] = [
  {
    modelId: "sample-pedestal",
    name: "示例底座（可删除）",
    kind: "box",
    color: "#eef2f4",
    visible: true,
    opacity: 1,
    transform: {
      position: { x: 0, y: 0.12, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 3.8, y: 0.24, z: 2.6 },
    },
    material: { color: "#eef2f4", roughness: 0.82, metalness: 0 },
    collisionEnabled: false,
  },
  {
    modelId: "sample-pillar",
    name: "示例立柱（点击试试）",
    kind: "cylinder",
    color: "#b8c2ca",
    visible: true,
    opacity: 1,
    transform: {
      position: { x: 0, y: 1.04, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 0.32, y: 1.6, z: 0.32 },
    },
    material: { color: "#b8c2ca", roughness: 0.24, metalness: 0.72 },
    collisionEnabled: false,
  },
  {
    modelId: SAMPLE_BEHAVIOR_TARGET_ID,
    name: "示例行为热点（可删除）",
    kind: "sphere",
    color: "#6fd4cf",
    visible: true,
    opacity: 1,
    transform: {
      position: { x: 0, y: 2.78, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 0.38, y: 0.38, z: 0.38 },
    },
    material: {
      color: "#6fd4cf",
      roughness: 0.78,
      metalness: 0,
      emissive: "#2b8f8a",
      emissiveIntensity: 0.45,
    },
    effects: {
      outline: true,
      glow: true,
      xray: false,
      scanline: false,
      heatmap: false,
      dissolve: 0,
      edgeLight: true,
      color: "#6fd4cf",
      intensity: 0.7,
    },
    collisionEnabled: false,
  },
];

export function shouldInjectDefaultSceneSample(options?: SceneCreationOptions): boolean {
  return (options?.template ?? "sample") === "sample";
}

export function createDefaultSceneSample(options?: SceneCreationOptions, createdAt = new Date().toISOString()): DefaultSceneSampleContent | undefined {
  if (!shouldInjectDefaultSceneSample(options)) return undefined;
  return {
    camera: structuredClone(SAMPLE_CAMERA),
    cameraViews: [{
      id: SAMPLE_CAMERA_VIEW_ID,
      name: "示例总览",
      camera: structuredClone(SAMPLE_CAMERA),
      createdAt,
    }],
    defaultCameraViewId: SAMPLE_CAMERA_VIEW_ID,
    primitives: structuredClone(SAMPLE_PRIMITIVES),
    interactions: [{
      id: "sample-click-behavior",
      name: "示例：点击热点聚焦",
      target: { kind: "object", modelId: SAMPLE_BEHAVIOR_TARGET_ID },
      trigger: "click",
      enabled: true,
      actions: [
        { id: "sample-focus", type: "focus", enabled: true },
        { id: "sample-message", type: "message", enabled: true, message: "示例本体已响应：你可以删除这些对象并开始搭建自己的场景。" },
      ],
      code: "",
    }],
  };
}
