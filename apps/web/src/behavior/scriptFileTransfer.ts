import type { ApplicationScriptLifecycle, ApplicationScriptTarget, ScriptModule } from "@bim-studio/contracts";

const LIFECYCLES: ApplicationScriptLifecycle[] = ["onStart", "onUpdate", "onFixedUpdate", "onData", "onEvent", "onStop", "onDispose"];

/** 每个上传文件转成独立脚本模块，不会拼成难以维护的单文件。 */
export async function createImportedBehaviorScript(
  file: File,
  preferredTarget?: { kind: "object" | "component"; id: string },
): Promise<ScriptModule> {
  if (!/\.(?:m?js)$/i.test(file.name)) throw new Error(`不支持的脚本文件：${file.name}`);
  if (file.size <= 0 || file.size > 2 * 1024 * 1024) throw new Error(`${file.name} 必须小于 2 MB 且不能为空`);
  const code = await file.text();
  const target: ApplicationScriptTarget = preferredTarget ? { ...preferredTarget } : { kind: "scene" };
  const lifecycle = LIFECYCLES.filter((name) => new RegExp(`\\b${name}\\b`).test(code));
  return {
    id: `behavior:${crypto.randomUUID()}`,
    name: file.name.replace(/\.(?:m?js)$/i, "") || "Imported behavior",
    enabled: true,
    apiVersion: "1.0",
    entrypoint: "behavior",
    runtime: "worker-sandbox",
    code,
    lifecycle: lifecycle.length ? lifecycle : ["onStart"],
    capabilities: ["studio.runtime"],
    permissions: ["scene.read"],
    target,
  };
}

export function scriptDownloadFileName(name: string): string {
  const safe = name.trim().replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-").replace(/[. ]+$/g, "").slice(0, 96) || "behavior";
  return `${safe}.js`;
}
