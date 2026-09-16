import { resolveSceneScriptProtocolCompatibility, type ScriptModule } from "@bim-studio/contracts";
import {
  SCENE_API_VERSION,
  type SceneBehaviorModule,
  type SceneBehaviorDependencyModule,
  type SceneCapability,
  type ScenePermission
} from "./protocol.js";

export type ScriptModuleResolution =
  | { status: "ready"; module: SceneBehaviorModule }
  | { status: "skipped"; message: string }
  | { status: "rejected"; message: string };

/** Narrows persisted application strings at the public Scene SDK boundary. */
export function resolveSceneBehaviorModule(
  script: ScriptModule,
  dependencies: readonly SceneBehaviorDependencyModule[] = [],
): ScriptModuleResolution {
  const compatibility = resolveSceneScriptProtocolCompatibility(script);
  if (compatibility.status !== "ready") return compatibility;
  return {
    status: "ready",
    module: {
      id: script.id,
      name: script.name,
      apiVersion: SCENE_API_VERSION,
      code: script.code,
      lifecycle: [...script.lifecycle],
      capabilities: [...script.capabilities] as SceneCapability[],
      permissions: [...script.permissions] as ScenePermission[],
      ...(script.target ? { target: structuredClone(script.target) } : {}),
      // SDK 合同需要可序列化的普通数组；显式复制同时切断调用方的只读引用。
      ...(dependencies.length ? { dependencies: dependencies.map((dependency) => structuredClone(dependency)) } : {}),
    }
  };
}
