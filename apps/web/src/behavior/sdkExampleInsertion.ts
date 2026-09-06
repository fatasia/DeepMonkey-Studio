import type { ScriptModule } from "@bim-studio/contracts";
import { getSdkExample, type SdkExampleId } from "../docs/sdkExamples";

export interface SdkExampleInsertRequest {
  requestId: string;
  exampleId: SdkExampleId;
  projectId: string;
  applicationId: string;
}

export interface SdkExampleWorkspaceContext {
  authenticated: boolean;
  projectId?: string;
  projectName?: string;
  applicationId?: string;
  unavailableReason?: string;
}

export function sdkExampleUnavailableReason(context: SdkExampleWorkspaceContext): string | undefined {
  if (!context.authenticated) return "请先登录并打开项目，再从编辑器进入文档新增样例。";
  if (context.unavailableReason) return context.unavailableReason;
  if (!context.projectId || !context.applicationId) return "请先打开项目的二维或三维编辑器，再从文档新增样例。";
  return undefined;
}

/** 只准备新增文件；应用、保存和执行仍由编辑器现有工作流决定。 */
export function createSdkExampleScript(
  exampleId: SdkExampleId,
  scripts: readonly ScriptModule[],
  createId: () => string = () => `behavior:${crypto.randomUUID()}`,
): ScriptModule {
  const example = getSdkExample(exampleId);
  if (!example) throw new Error("样例已不可用，请重新选择。");
  const id = createId();
  if (!id || scripts.some(script => script.id === id)) throw new Error("未能生成独立脚本标识，请重试。");
  const names = new Set(scripts.map(script => normalizeName(script.name)));
  const stem = example.fileName.replace(/\.js$/i, "");
  let name = example.fileName;
  for (let suffix = 2; names.has(normalizeName(name)); suffix++) name = `${stem}-${suffix}.js`;
  return {
    id, name, enabled: true, apiVersion: "1.0", entrypoint: "behavior", runtime: "worker-sandbox",
    target: { kind: "scene" }, code: example.code,
    lifecycle: [...example.lifecycle], capabilities: [...example.capabilities], permissions: [...example.permissions],
  };
}

function normalizeName(name: string): string {
  return name.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}
