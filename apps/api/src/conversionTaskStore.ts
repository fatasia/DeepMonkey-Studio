import type { ConversionTaskRecord, DatabaseDocument, ModelRecord } from "@bim-studio/contracts";
import { isDeepStrictEqual } from "node:util";
import { ConversionTaskError } from "./conversionTaskError.js";

/** 在现有元数据事务内同时提交任务和活动模型指针。 */
export function saveConversionTaskMutation(document: DatabaseDocument, task: ConversionTaskRecord, updates?: Partial<ModelRecord>): boolean {
  const project = document.projects.find(item => item.id === task.projectId);
  if (!project) throw new ConversionTaskError("转换任务项目不存在", "not_found");
  const records = document.conversionTasks ??= [];
  if (task.idempotencyKey && records.some(item => item.id !== task.id && item.projectId === task.projectId && item.idempotencyKey === task.idempotencyKey)) throw new ConversionTaskError("转换任务幂等键冲突", "conflict");
  const previous = records.find(item => item.id === task.id);
  if (previous && (previous.projectId !== task.projectId || previous.modelId !== task.modelId)) throw new ConversionTaskError("转换任务身份冲突", "conflict");
  if (previous && ["succeeded", "failed", "cancelled"].includes(previous.status)) {
    // 重复回调只能确认原结果，不能利用相同终态重写产物或抢回较新 attempt 的指针。
    if (!isDeepStrictEqual(previous, task)) throw new ConversionTaskError("转换任务终态不可改写", "conflict");
    const model = task.modelId && project.models.find(item => item.id === task.modelId);
    if (updates && (!model || task.status !== "succeeded"
      || ["id", "projectId", "sourceUrl", "conversionTaskId"].some(key => Object.hasOwn(updates, key))
      || Object.entries(updates).some(([key, value]) => !isDeepStrictEqual(model[key as keyof ModelRecord], value)))) {
      throw new ConversionTaskError("转换任务终态不能替换已发布产物", "conflict");
    }
    return false;
  }
  if (task.modelId) {
    const model = project.models.find(item => item.id === task.modelId);
    if (!model) throw new ConversionTaskError("转换任务模型不存在", "not_found");
    const active = records.find(item => item.id === model.conversionTaskId);
    if (model.conversionTaskId !== task.id) {
      if (previous || active && !["failed", "cancelled", "succeeded"].includes(active.status)) throw new ConversionTaskError("模型已有活动转换任务", "conflict");
      model.conversionTaskId = task.id;
    }
    if (updates) {
      if (task.status !== "succeeded") throw new Error("只有成功任务可以提交模型产物");
      if (updates.id !== undefined || updates.projectId !== undefined || updates.sourceUrl !== undefined || updates.conversionTaskId !== undefined) throw new Error("转换任务不能更改模型来源身份");
      if (updates.manifest && (updates.manifest.modelId !== model.id || updates.manifest.sourceFormat !== model.format)) throw new Error("转换清单与模型身份不一致");
      // inspect 或失败复转不能撤销已经发布的 ready 版本。
      if (model.status !== "ready" || updates.status === "ready") Object.assign(model, structuredClone(updates), { updatedAt: task.updatedAt });
    } else if (["failed", "cancelled"].includes(task.status) && model.status !== "ready") {
      Object.assign(model, { status: "failed", progress: 100, message: task.message, updatedAt: task.updatedAt });
    } else if ((task.status === "queued" || task.status === "running") && model.status !== "ready") {
      Object.assign(model, { status: task.status === "queued" ? "queued" : "processing", progress: task.progress, message: task.message });
    }
  } else if (updates) throw new Error("任务未关联模型");
  const index = records.findIndex(item => item.id === task.id);
  if (index < 0) records.push(structuredClone(task));
  else records[index] = structuredClone(task);
  return true;
}
