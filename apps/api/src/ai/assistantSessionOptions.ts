import type { AiRuntimeSettings } from "./assistantService.js";
import { fetchProviderModels } from "./aiModelCatalog.js";
import { autoRoutingAvailable } from "./assistantModelRouter.js";

type Effort = "minimal" | "standard" | "deep";
/** routing:"auto" 表示由服务端路由器在默认模型与小模型间选择；显式 model 永远优先。 */
export interface AssistantSessionOptions { model?: string; reasoningEffort?: Effort; routing?: "auto" }
export class AssistantSessionOptionError extends Error {}

/** 仅当用户选择自动且没有显式模型时才启用路由；其余情况严格使用所选/默认模型。 */
export function requestedRouting(input: AssistantSessionOptions): { routing?: "auto" } {
  return input.routing === "auto" && input.model === undefined ? { routing: "auto" } : {};
}

export async function assistantSessionCatalog(settings: AiRuntimeSettings) {
  const compatible = settings.providerId === "ai.openai-compatible";
  const result = compatible ? await fetchProviderModels(settings) : undefined;
  const ids = new Set([settings.model, ...(result?.ok ? result.models : [])]);
  return {
    defaultModel: settings.model,
    // 「自动」仅在配置了小模型（且在目录内）时可用；UI 据此显示选项与实际路由目标。
    routing: {
      autoAvailable: autoRoutingAvailable(settings, result?.ok ? result.models : undefined),
      strongModel: settings.model,
      ...(settings.routing?.fastModel ? { fastModel: settings.routing.fastModel } : {}),
    },
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
  if (input.routing !== undefined && input.routing !== "auto") throw new AssistantSessionOptionError("路由模式无效");
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
