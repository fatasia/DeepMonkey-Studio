import type { ProjectRecord } from "@bim-studio/contracts";
import { api } from "./api";

export function isModelLoadSuperseded(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "ModelLoadSupersededError";
}

export async function waitForModelReady(projectId: string, modelId: string): Promise<ProjectRecord> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const current = await api.getProject(projectId);
    const model = current.models.find((item) => item.id === modelId);
    if (!model) throw new Error("导入的模型资源不存在");
    if (model.status === "ready") return current;
    if (model.status === "failed" || model.status === "waiting_converter") throw new Error(model.message);
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  throw new Error("模型资源处理超时，请稍后在项目资源中查看");
}
