import type { SceneBehaviorModule, SceneCapability, SceneCommand } from "@bim-studio/scene-sdk";

export interface SceneCommandAuthorization {
  allowed: SceneCommand[];
  rejected: Array<{ command: SceneCommand; message: string }>;
}

export function authorizeSceneCommands(module: SceneBehaviorModule, commands: readonly SceneCommand[]): SceneCommandAuthorization {
  const allowed: SceneCommand[] = [];
  const rejected: SceneCommandAuthorization["rejected"] = [];
  for (const command of commands) {
    const required = requiredCapability(command.type);
    const missing = required.filter((capability) => !module.capabilities.includes(capability));
    if (!module.permissions.includes("scene.write")) {
      rejected.push({ command, message: "脚本没有 scene.write 权限" });
    } else if (missing.length > 0) {
      rejected.push({ command, message: `脚本未声明能力：${missing.join("、")}` });
    } else {
      allowed.push(command);
    }
  }
  return { allowed, rejected };
}

function requiredCapability(type: SceneCommand["type"]): SceneCapability[] {
  if (type.startsWith("unity.")) return ["studio.unity"];
  if (type === "component.update") return ["studio.component"];
  if (type === "camera.set" || type === "camera.fly-to") return ["studio.camera"];
  if (type === "animation.control") return ["studio.animation"];
  if (type === "material.set") return ["studio.material", "studio.object"];
  if (type === "data.apply") return ["studio.data", "studio.object"];
  if (type === "selection.set") return ["studio.scene"];
  return ["studio.object"];
}
