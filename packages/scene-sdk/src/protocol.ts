import type {
  DirectBindingSpec,
  DirectBindingTemplateValue,
  JsonValue,
  SceneMaterialState,
  SceneApiVersion,
  SceneCapability,
  ScenePermission,
} from "@bim-studio/contracts";

export {
  SCENE_API_VERSION, SCENE_CAPABILITIES, SCENE_PERMISSIONS,
  type SceneApiVersion, type SceneCapability, type ScenePermission,
} from "@bim-studio/contracts";

export type SceneObjectRef =
  | { kind: "scene"; sceneId: string }
  | { kind: "object"; sceneId: string; objectId: string }
  | { kind: "mesh"; sceneId: string; objectId: string; meshId: string };

/** Worker 行为脚本可安全修改的高频材质参数；贴图 URL 仍由受信任编辑器和素材库管理。 */
export type SceneMaterialCommandPatch = Pick<
  SceneMaterialState,
  | "color"
  | "emissive"
  | "emissiveIntensity"
  | "roughness"
  | "metalness"
  | "normalScale"
  | "textureRepeat"
  | "textureRepeatX"
  | "textureRepeatY"
  | "textureOffsetX"
  | "textureOffsetY"
  | "textureRotation"
  | "wireframe"
  | "doubleSided"
>;

export type SceneCommand =
  | { id: string; type: "object.set-visibility"; target: SceneObjectRef; visible: boolean }
  | { id: string; type: "object.set-transform"; target: SceneObjectRef; position?: [number, number, number]; rotation?: [number, number, number]; scale?: [number, number, number] }
  | { id: string; type: "material.set"; target: SceneObjectRef; patch: SceneMaterialCommandPatch }
  | { id: string; type: "selection.set"; targets: SceneObjectRef[] }
  | { id: string; type: "camera.set"; sceneId: string; position: [number, number, number]; target: [number, number, number]; near?: number; far?: number; fov?: number }
  | { id: string; type: "camera.fly-to"; sceneId: string; target: SceneObjectRef | { position: [number, number, number] }; durationMs: number }
  | { id: string; type: "animation.control"; target: SceneObjectRef; action: "play" | "pause" | "stop" | "seek"; clipId?: string; time?: number }
  | { id: string; type: "data.apply"; target: SceneObjectRef; values: Record<string, JsonValue>; timestamp: string }
  | { id: string; type: "component.update"; componentId: string; patch: Record<string, JsonValue> }
  | { id: string; type: "unity.properties.set"; componentId: string; values: Record<string, JsonValue> }
  | { id: string; type: "unity.action.invoke"; componentId: string; action: string; objectId?: string; value?: JsonValue }
  | { id: string; type: "unity.scene.switch"; componentId: string; scene: string };

export type SceneQuery =
  | { id: string; type: "object.get"; target: SceneObjectRef }
  | { id: string; type: "object.search"; sceneId: string; text?: string; tags?: string[] }
  | { id: string; type: "camera.get"; sceneId: string }
  | { id: string; type: "capabilities.get" };

export type SceneEvent =
  | { type: "scene.ready" | "scene.disposed"; sceneId: string; timestamp: string }
  | { type: "selection.changed"; sceneId: string; targets: SceneObjectRef[]; timestamp: string }
  | { type: "object.event"; name: string; target: SceneObjectRef; timestamp: string; data?: JsonValue }
  | { type: "business.event"; name: string; sceneId: string; sourceModuleId: string; timestamp: string; data?: JsonValue }
  | { type: "data.received"; sceneId: string; timestamp: string; data: JsonValue };

export type SceneScriptLifecycle = "onStart" | "onUpdate" | "onFixedUpdate" | "onData" | "onEvent" | "onStop" | "onDispose";
export type SceneBehaviorTarget = { kind: "scene" } | { kind: "object" | "component"; id: string };
export type SceneExtensionExecution = "worker-sandbox" | "trusted-main-thread";
export type SceneHostKind = "browser" | "tauri" | "cloud";
export type SceneRendererKind = "webgl2" | "webgpu";

export interface SceneExtensionManifest {
  id: string;
  name: string;
  version: string;
  /** External manifests may target a newer SDK; compatibility negotiation validates this string before loading. */
  apiVersion: string;
  entry: string;
  execution: SceneExtensionExecution;
  capabilities: SceneCapability[];
  permissions: ScenePermission[];
  hosts: SceneHostKind[];
  renderers: SceneRendererKind[];
  lifecycle: SceneScriptLifecycle[];
}

export interface SceneBehaviorModule {
  id: string;
  name: string;
  apiVersion: SceneApiVersion;
  code: string;
  lifecycle: SceneScriptLifecycle[];
  capabilities: SceneCapability[];
  permissions: ScenePermission[];
  target?: SceneBehaviorTarget;
  /** 已由宿主校验哈希并读取的离线模块；Worker 不直接访问来源网络。 */
  dependencies?: SceneBehaviorDependencyModule[];
}

export interface SceneBehaviorDependencyModule {
  specifier: string;
  code: string;
  integrity: string;
}

export interface SceneBehaviorRuntimeSettings {
  fixedStepMs: number;
  maxFixedStepsPerFrame: number;
  timeScale: number;
  updateEnabled: boolean;
}

export interface SceneBehaviorTick {
  sequence: number;
  lifecycle: "onUpdate" | "onFixedUpdate";
  deltaMs: number;
  elapsedMs: number;
  frame: number;
}

export interface SceneBehaviorNetworkRequest {
  requestId: string;
  invocationId: string;
  binding: DirectBindingSpec;
  variables: Record<string, DirectBindingTemplateValue>;
}

export interface SceneBehaviorNetworkResult {
  ok: true;
  status: number;
  data: JsonValue;
  value: JsonValue;
}

/** Worker 行为脚本通过宿主调用的受管项目能力；结果保持 JSON 可序列化，避免向沙箱泄露宿主对象。 */
export interface SceneBehaviorCapabilityRequest {
  requestId: string;
  invocationId: string;
  capabilityId: string;
  input: JsonValue;
}

export type SceneBehaviorLogLevel = "debug" | "info" | "warn" | "error";

export type SceneBehaviorWorkerRequest =
  | { type: "behavior.initialize"; module: SceneBehaviorModule; sceneId: string }
  | { type: "behavior.invoke"; invocationId: string; lifecycle: SceneScriptLifecycle; elapsedMs: number; deltaMs?: number; event?: SceneEvent; data?: JsonValue }
  | { type: "behavior.dispose"; invocationId: string }
  | { type: "behavior.network.result"; requestId: string; result?: SceneBehaviorNetworkResult; error?: string }
  | { type: "behavior.capability.result"; requestId: string; result?: JsonValue; error?: string };

export type SceneBehaviorWorkerResponse =
  | { type: "behavior.ready"; moduleId: string; lifecycle: SceneScriptLifecycle[] }
  | { type: "behavior.result"; invocationId: string; durationMs: number; commands: SceneCommand[]; dataUpdates?: Record<string, JsonValue>; events?: Array<{ name: string; payload?: JsonValue }> }
  | ({ type: "behavior.network.request" } & SceneBehaviorNetworkRequest)
  | ({ type: "behavior.capability.request" } & SceneBehaviorCapabilityRequest)
  | { type: "behavior.log"; level: SceneBehaviorLogLevel; message: string; data?: JsonValue }
  | { type: "behavior.error"; invocationId?: string; message: string; stack?: string; location?: { line: number; column: number } };
