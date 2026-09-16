import type { ScriptModule } from "./application.js";

/** 持久化脚本、发布预检与运行适配共用的协议身份。 */
export const SCENE_API_VERSION = "1.0" as const;
export type SceneApiVersion = typeof SCENE_API_VERSION;

export const SCENE_CAPABILITIES = [
  "studio.scene",
  "studio.object",
  "studio.component",
  "studio.unity",
  "studio.mesh",
  "studio.material",
  "studio.camera",
  "studio.controls",
  "studio.animation",
  "studio.timeline",
  "studio.input",
  "studio.data",
  "studio.ai",
  "studio.runtime"
] as const;
export type SceneCapability = typeof SCENE_CAPABILITIES[number];

export const SCENE_PERMISSIONS = [
  "scene.read",
  "scene.write",
  "data.read",
  "data.write",
  "ai.invoke",
  "network.connect",
  "renderer.extend",
  "editor.extend"
] as const;
export type ScenePermission = typeof SCENE_PERMISSIONS[number];

export type SceneScriptProtocolCompatibility =
  | { status: "ready" }
  | { status: "skipped"; message: string }
  | { status: "rejected"; message: string };

const capabilities = new Set<string>(SCENE_CAPABILITIES);
const permissions = new Set<string>(SCENE_PERMISSIONS);

/** 只判定已解析脚本的协议兼容性；运行模块组装仍归 SDK。 */
export function resolveSceneScriptProtocolCompatibility(
  script: Pick<ScriptModule, "enabled" | "runtime" | "capabilities" | "permissions"> & { apiVersion: string },
): SceneScriptProtocolCompatibility {
  if (!script.enabled) return { status: "skipped", message: "脚本已禁用" };
  if (script.runtime !== "worker-sandbox") return { status: "skipped", message: "旧版可信脚本不会自动进入 Worker 运行时" };
  if (script.apiVersion !== SCENE_API_VERSION) return { status: "rejected", message: `不支持 Scene API ${script.apiVersion}` };
  const unknownCapabilities = script.capabilities.filter(item => !capabilities.has(item));
  if (unknownCapabilities.length > 0) return { status: "rejected", message: `未知能力：${unknownCapabilities.join("、")}` };
  const unknownPermissions = script.permissions.filter(item => !permissions.has(item));
  if (unknownPermissions.length > 0) return { status: "rejected", message: `未知权限：${unknownPermissions.join("、")}` };
  return { status: "ready" };
}
