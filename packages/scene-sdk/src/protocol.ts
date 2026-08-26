import type { DirectBindingSpec, DirectBindingTemplateValue, JsonValue } from "@bim-studio/contracts";

export const SCENE_API_VERSION = "1.0" as const;
export type SceneApiVersion = typeof SCENE_API_VERSION;

export const SCENE_CAPABILITIES = [
  "studio.scene",
  "studio.object",
  "studio.component",
  "studio.mesh",
  "studio.material",
  "studio.camera",
  "studio.controls",
  "studio.animation",
  "studio.timeline",
  "studio.input",
  "studio.data",
  "studio.runtime"
] as const;
export type SceneCapability = typeof SCENE_CAPABILITIES[number];

export const SCENE_PERMISSIONS = [
  "scene.read",
  "scene.write",
  "data.read",
  "data.write",
  "network.connect",
  "renderer.extend",
  "editor.extend"
] as const;
export type ScenePermission = typeof SCENE_PERMISSIONS[number];

export type SceneObjectRef =
  | { kind: "scene"; sceneId: string }
  | { kind: "object"; sceneId: string; objectId: string }
  | { kind: "mesh"; sceneId: string; objectId: string; meshId: string };

export type SceneCommand =
  | { id: string; type: "object.set-visibility"; target: SceneObjectRef; visible: boolean }
  | { id: string; type: "object.set-transform"; target: SceneObjectRef; position?: [number, number, number]; rotation?: [number, number, number]; scale?: [number, number, number] }
  | { id: string; type: "selection.set"; targets: SceneObjectRef[] }
  | { id: string; type: "camera.set"; sceneId: string; position: [number, number, number]; target: [number, number, number]; near?: number; far?: number; fov?: number }
  | { id: string; type: "camera.fly-to"; sceneId: string; target: SceneObjectRef | { position: [number, number, number] }; durationMs: number }
  | { id: string; type: "animation.control"; target: SceneObjectRef; action: "play" | "pause" | "stop" | "seek"; clipId?: string; time?: number }
  | { id: string; type: "data.apply"; target: SceneObjectRef; values: Record<string, JsonValue>; timestamp: string }
  | { id: string; type: "component.update"; componentId: string; patch: Record<string, JsonValue> };

export type SceneQuery =
  | { id: string; type: "object.get"; target: SceneObjectRef }
  | { id: string; type: "object.search"; sceneId: string; text?: string; tags?: string[] }
  | { id: string; type: "camera.get"; sceneId: string }
  | { id: string; type: "capabilities.get" };

export type SceneEvent =
  | { type: "scene.ready" | "scene.disposed"; sceneId: string; timestamp: string }
  | { type: "selection.changed"; sceneId: string; targets: SceneObjectRef[]; timestamp: string }
  | { type: "object.event"; name: string; target: SceneObjectRef; timestamp: string; data?: JsonValue }
  | { type: "data.received"; sceneId: string; timestamp: string; data: JsonValue };

export type SceneScriptLifecycle = "onStart" | "onUpdate" | "onFixedUpdate" | "onData" | "onEvent" | "onStop" | "onDispose";
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

export type SceneBehaviorLogLevel = "debug" | "info" | "warn" | "error";

export type SceneBehaviorWorkerRequest =
  | { type: "behavior.initialize"; module: SceneBehaviorModule; sceneId: string }
  | { type: "behavior.invoke"; invocationId: string; lifecycle: SceneScriptLifecycle; elapsedMs: number; deltaMs?: number; event?: SceneEvent; data?: JsonValue }
  | { type: "behavior.dispose"; invocationId: string }
  | { type: "behavior.network.result"; requestId: string; result?: SceneBehaviorNetworkResult; error?: string };

export type SceneBehaviorWorkerResponse =
  | { type: "behavior.ready"; moduleId: string; lifecycle: SceneScriptLifecycle[] }
  | { type: "behavior.result"; invocationId: string; durationMs: number; commands: SceneCommand[] }
  | ({ type: "behavior.network.request" } & SceneBehaviorNetworkRequest)
  | { type: "behavior.log"; level: SceneBehaviorLogLevel; message: string; data?: JsonValue }
  | { type: "behavior.error"; invocationId?: string; message: string; stack?: string };
