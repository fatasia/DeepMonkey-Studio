import type { ScriptModule } from "@bim-studio/contracts";
import {
  SCENE_API_VERSION,
  SCENE_CAPABILITIES,
  SCENE_PERMISSIONS,
  type SceneBehaviorModule,
  type SceneCapability,
  type ScenePermission
} from "@bim-studio/scene-sdk";

export type ScriptModuleResolution =
  | { status: "ready"; module: SceneBehaviorModule }
  | { status: "skipped"; message: string }
  | { status: "rejected"; message: string };

const capabilities = new Set<string>(SCENE_CAPABILITIES);
const permissions = new Set<string>(SCENE_PERMISSIONS);

/** Narrows persisted application strings at the public Scene SDK boundary. */
export function resolveSceneBehaviorModule(script: ScriptModule): ScriptModuleResolution {
  if (!script.enabled) return { status: "skipped", message: "脚本已禁用" };
  if (script.runtime !== "worker-sandbox") return { status: "skipped", message: "旧版可信脚本不会自动进入 Worker 运行时" };
  if (script.apiVersion !== SCENE_API_VERSION) return { status: "rejected", message: `不支持 Scene API ${script.apiVersion}` };
  const unknownCapabilities = script.capabilities.filter((item) => !capabilities.has(item));
  if (unknownCapabilities.length > 0) return { status: "rejected", message: `未知能力：${unknownCapabilities.join("、")}` };
  const unknownPermissions = script.permissions.filter((item) => !permissions.has(item));
  if (unknownPermissions.length > 0) return { status: "rejected", message: `未知权限：${unknownPermissions.join("、")}` };
  return {
    status: "ready",
    module: {
      id: script.id,
      name: script.name,
      apiVersion: SCENE_API_VERSION,
      code: script.code,
      lifecycle: [...script.lifecycle],
      capabilities: [...script.capabilities] as SceneCapability[],
      permissions: [...script.permissions] as ScenePermission[]
    }
  };
}
