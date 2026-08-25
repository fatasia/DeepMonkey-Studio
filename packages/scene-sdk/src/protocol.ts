import type { JsonValue } from "@bim-studio/contracts";

export const SCENE_API_VERSION = "1.0" as const;
export type SceneApiVersion = typeof SCENE_API_VERSION;

export const SCENE_CAPABILITIES = [
  "studio.scene",
  "studio.object",
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
  | { id: string; type: "data.apply"; target: SceneObjectRef; values: Record<string, JsonValue>; timestamp: string };

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
