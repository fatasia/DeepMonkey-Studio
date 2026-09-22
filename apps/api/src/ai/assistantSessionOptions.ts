import type { AiRuntimeSettings } from "./assistantService.js";
import { fetchProviderModels } from "./aiModelCatalog.js";

type Effort = "minimal" | "standard" | "deep";
export interface AssistantSessionOptions { model?: string; reasoningEffort?: Effort }
export class AssistantSessionOptionError extends Error {}

export async function assistantSessionCatalog(settings: AiRuntimeSettings) {
  const compatible = settings.providerId === "ai.openai-compatible";
  const result = compatible ? await fetchProviderModels(settings) : undefined;
  const ids = new Set([settings.model, ...(result?.ok ? result.models : [])]);
  return {
    defaultModel: settings.model,
    models: [...ids].filter(Boolean).map(id => ({
      id,
      // /models 没有能力合同：仅复用管理员已启用思考参数的主模型，不按名称猜测。
      reasoningEfforts: compatible && id === settings.model && settings.reasoningEffort
        ? ["minimal", "standard", "deep"] as Effort[] : [],
    })),
    catalogAvailable: Boolean(result?.ok),
  };
}

export async function resolveAssistantSessionOptions(settings: AiRuntimeSettings, input: AssistantSessionOptions, mode?: string): Promise<AiRuntimeSettings> {
  if (input.model === undefined && input.reasoningEffort === undefined) return settings;
  if (mode === "sql") throw new AssistantSessionOptionError("问数使用受控查询服务，不支持会话模型设置");
  if (input.model !== undefined && (typeof input.model !== "string" || !input.model.trim() || input.model.length > 256)) {
    throw new AssistantSessionOptionError("模型参数无效");
  }
  if (input.reasoningEffort !== undefined && !["minimal", "standard", "deep"].includes(input.reasoningEffort)) {
    throw new AssistantSessionOptionError("思考档位无效");
  }
  const model = input.model ?? settings.model;
  const catalog = model === settings.model
    ? { models: [{ id: model, reasoningEfforts: settings.providerId === "ai.openai-compatible" && settings.reasoningEffort ? ["minimal", "standard", "deep"] : [] }] }
    : await assistantSessionCatalog(settings);
  const descriptor = catalog.models.find(item => item.id === model);
  if (!descriptor) throw new AssistantSessionOptionError("模型不在当前服务目录中，请刷新模型列表");
  if (input.reasoningEffort && !descriptor.reasoningEfforts.includes(input.reasoningEffort)) {
    throw new AssistantSessionOptionError("此模型尚未配置思考档位支持");
  }
  const { reasoningEffort: originalEffort, ...rest } = settings;
  const effort = input.reasoningEffort ?? (model === settings.model ? originalEffort : undefined);
  return { ...rest, model, ...(effort ? { reasoningEffort: effort } : {}) };
}
