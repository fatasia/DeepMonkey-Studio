import { randomUUID } from "node:crypto";
import type { CapabilityJsonSchema, CapabilityProvider, PluginRegistry } from "@bim-studio/plugin-runtime";
import { PARAMETRIC_CAD_TEMPLATES, PARAMETRIC_DRAFT_INSTRUCTIONS, parseParametricDraft } from "@bim-studio/parametric-modeling-plugin";
import { safeErrorMessage } from "./aiReliabilityAudit.js";
import { prepareAiInput, reliabilityEvidence, reliabilitySystemBoundary } from "./aiReliabilityPolicy.js";
import type { AiRuntimeSettings } from "./assistantService.js";

interface DraftInput { prompt: string; }

const inputSchema: CapabilityJsonSchema = {
  type: "object", additionalProperties: false, required: ["prompt"],
  properties: { prompt: { type: "string", minLength: 3, maxLength: 4_000 } }
};

const outputSchema: CapabilityJsonSchema = {
  type: "object", additionalProperties: false, required: ["definition", "model", "providerId"],
  properties: {
    definition: { type: "object", additionalProperties: true },
    model: { type: "string" },
    providerId: { type: "string" }
  }
};

/**
 * 参数化 AI 是独立插件：可随时禁用或替换，而确定性模板、校验和 CAD 构建仍可正常使用。
 * 大模型输出只作为 research-candidate 草案，经受限 DSL 校验后才返回页面。
 */
export async function registerParametricAiPlugin(registry: PluginRegistry, settingsProvider: () => AiRuntimeSettings): Promise<void> {
  const manifest = {
    schemaVersion: 1 as const,
    id: "bim.ai.parametric-draft",
    name: "Parametric modeling AI draft",
    version: "1.0.0",
    apiVersion: "1.0",
    hosts: ["cloud"] as const,
    capabilities: ["modeling.parametric.ai"],
    permissions: ["modeling.write", "ai.invoke"],
    extensionPoints: [{
      kind: "capability.provider" as const,
      id: "bim.parametric-ai-capability",
      capabilityIds: ["modeling.parametric.draft"],
      execution: "in-process" as const,
      limits: { timeoutMs: 90_000, maxInputBytes: 64 * 1024, memoryMb: 128 }
    }]
  };
  const registered = registry.register(manifest, ({ registerCapability }) => {
    const result = registerCapability(createDraftProvider(registry, settingsProvider));
    if (!result.ok) throw new Error(`参数化 AI 能力注册失败：${result.message}`);
  });
  if (!registered.ok) throw new Error(`参数化 AI 插件不兼容：${registered.message}`);
  const enabled = await registry.enable(manifest.id);
  if (!enabled.ok) throw new Error(`参数化 AI 插件启用失败：${enabled.message}`);
}

function createDraftProvider(registry: PluginRegistry, settingsProvider: () => AiRuntimeSettings): CapabilityProvider<DraftInput> {
  return {
    descriptor: {
      id: "modeling.parametric.draft", version: "1.0.0", label: "AI 参数化草案", kind: "model", execution: "in-process",
      permissions: ["modeling.write", "ai.invoke"], timeoutMs: 90_000,
      inputSchemaVersion: "1.0", outputSchemaVersion: "1.0", inputSchema, outputSchema
    },
    async invoke(request, context) {
      const settings = settingsProvider();
      if (!settings.apiKey) return {
        status: "needs-input", decisionStatus: "insufficient-data",
        warnings: ["尚未配置大模型 API Key，请由管理员在系统设置中完成 AI Provider 配置"]
      };
      if (!registry.getAiProvider(settings.providerId)) return {
        status: "unavailable", decisionStatus: "insufficient-data",
        warnings: ["当前 AI Provider 已停用；确定性模板与参数编辑仍可正常使用"]
      };
      const prompt = request.input.prompt.trim();
      const example = JSON.stringify(PARAMETRIC_CAD_TEMPLATES[0]!.definition);
      const prepared = prepareAiInput(prompt, {});
      const reliability = reliabilityEvidence(prepared.assessment, request.requestId);
      if (prepared.assessment.decision === "block") return {
        status: "blocked", decisionStatus: "insufficient-data", evidence: [reliability],
        warnings: ["请求包含暴露敏感信息或绕过工具审批的高风险指令，未调用模型"],
      };
      let completion;
      try {
        completion = await registry.invokeAiProvider(settings.providerId, {
          requestId: randomUUID(), projectId: request.projectId, principal: request.principal,
          model: settings.model, instructions: `${PARAMETRIC_DRAFT_INSTRUCTIONS}\n${reliabilitySystemBoundary(prepared.assessment)}`,
          input: `用户需求：${prepared.question}\n字段结构示例（仅用于理解 schema，不要照抄尺寸）：${example}`,
          temperature: Math.min(0.3, Math.max(0, settings.temperature)), maxOutputTokens: 4_000,
          config: { baseUrl: settings.baseUrl, apiKey: settings.apiKey, protocol: settings.protocol }, signal: context.signal
        });
      } catch (error) {
        return {
          status: "unavailable", decisionStatus: "insufficient-data", evidence: [reliability],
          warnings: [`AI 参数化草案暂不可用：${safeErrorMessage(error)}；可继续使用确定性模板与参数编辑`],
        };
      }
      let definition;
      try { definition = parseParametricDraft(completion.text); }
      catch (error) {
        return {
          status: "needs-input", decisionStatus: "insufficient-data",
          evidence: [reliability, { id: `ai-draft:${request.requestId}`, kind: "model", label: "未通过合同校验的参数化草案", source: `${settings.providerId}:${completion.model}` }],
          warnings: [`AI 返回内容未通过受限参数化合同：${safeErrorMessage(error)}；可继续使用确定性模板`],
        };
      }
      return {
        status: "completed", decisionStatus: "research-candidate",
        output: { definition, model: completion.model, providerId: settings.providerId },
        evidence: [
          reliability,
          { id: `ai-draft:${request.requestId}`, kind: "model", label: "AI 参数化 DSL 草案", source: `${settings.providerId}:${completion.model}` },
          { id: `parametric-validation:${request.requestId}`, kind: "rule", label: "受限 DSL 与参数范围校验", source: "bim.parametric-modeling" }
        ],
        warnings: [
          "AI 草案尚未成为工程制品，必须完成几何预览并由用户确认后再保存",
          ...(prepared.assessment.findings.length ? ["输入包含可疑指令特征，已按不可信数据约束"] : []),
        ]
      };
    }
  };
}
