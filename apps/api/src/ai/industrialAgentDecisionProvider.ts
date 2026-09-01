import type { AgentDecisionProvider } from "@bim-studio/industrial-agent-orchestrator";
import type { PluginRegistry } from "@bim-studio/plugin-runtime";
import type { AiRuntimeSettings } from "./assistantService.js";
import { createAiAuditEvent, emitAiAudit, safeErrorMessage, type AiReliabilityAuditSink } from "./aiReliabilityAudit.js";
import { prepareAiInput, reliabilitySystemBoundary } from "./aiReliabilityPolicy.js";

const DECISION_INSTRUCTIONS = `你是工业 AI Agent 的受控决策器。你只能返回一个 JSON 对象，不得返回 Markdown。
允许的决策：
1. {"kind":"call-tool","rationale":"...","call":{"toolId":"...","arguments":{},"resources":[{"kind":"project","id":"项目ID","projectId":"项目ID"}]}}
2. {"kind":"finish","rationale":"...","summary":"...","decisionStatus":"production|shadow|insufficient-data","evidenceIds":["..."]}
3. {"kind":"stop","rationale":"...","code":"...","message":"..."}
不得虚构工具、证据或执行结果；production 结论必须引用已返回证据 ID；不要请求 shell、文件系统或未列出的工具。`;

/** Provider 只决定下一步，所有执行仍交给 Capability 与可靠性策略。 */
export function createIndustrialAgentDecisionProvider(input: {
  registry: PluginRegistry;
  settings: () => AiRuntimeSettings;
  audit?: AiReliabilityAuditSink;
}): AgentDecisionProvider {
  return {
    async decide(request) {
      const settings = input.settings();
      if (!settings.apiKey) throw new Error("尚未配置大模型 API Key，工业 Agent 无法生成下一步决策");
      const traceId = `${request.checkpoint.id}:decision:${request.checkpoint.usage.steps + 1}`;
      const prepared = prepareAiInput(request.checkpoint.objective, decisionContext(request));
      await emitAiAudit(input.audit, createAiAuditEvent({
        traceId,
        stage: "input-assessment",
        outcome: prepared.assessment.decision === "block" ? "denied" : prepared.assessment.decision === "constrain" ? "constrained" : "allowed",
        principal: request.checkpoint.principal,
        projectId: request.checkpoint.projectId,
        providerId: settings.providerId,
        model: settings.model,
        assessment: prepared.assessment,
      }));
      if (prepared.assessment.decision === "block") throw new Error("工业 Agent 输入触发高风险注入或审批绕过规则");
      try {
        const completion = await input.registry.invokeAiProvider(settings.providerId, {
          requestId: traceId,
          projectId: request.checkpoint.projectId,
          principal: request.checkpoint.principal,
          model: settings.model,
          instructions: `${DECISION_INSTRUCTIONS}\n${reliabilitySystemBoundary(prepared.assessment)}`,
          input: JSON.stringify({ objective: prepared.question, context: prepared.context }),
          temperature: Math.min(0.2, settings.temperature),
          maxOutputTokens: 1_800,
          config: { baseUrl: settings.baseUrl, apiKey: settings.apiKey, protocol: settings.protocol },
          signal: request.signal,
        });
        const decision = parseJsonDecision(completion.text);
        await emitAiAudit(input.audit, createAiAuditEvent({
          traceId, stage: "model-completion", outcome: "completed", principal: request.checkpoint.principal,
          projectId: request.checkpoint.projectId, providerId: settings.providerId, model: completion.model, assessment: prepared.assessment,
        }));
        return decision;
      } catch (error) {
        await emitAiAudit(input.audit, createAiAuditEvent({
          traceId, stage: "model-completion", outcome: request.signal.aborted ? "cancelled" : "failed", principal: request.checkpoint.principal,
          projectId: request.checkpoint.projectId, providerId: settings.providerId, model: settings.model, assessment: prepared.assessment,
          failure: { code: request.signal.aborted ? "cancelled" : "invalid-decision", message: safeErrorMessage(error), retryable: !request.signal.aborted },
        }));
        throw error;
      }
    },
  };
}

function decisionContext(request: Parameters<AgentDecisionProvider["decide"]>[0]) {
  const checkpoint = request.checkpoint;
  return {
    userContext: checkpoint.context,
    budgetRemaining: {
      steps: checkpoint.budget.maxSteps - checkpoint.usage.steps,
      tools: checkpoint.budget.maxToolCalls - checkpoint.usage.toolCalls,
      activeMs: checkpoint.budget.maxDurationMs - checkpoint.usage.activeDurationMs,
    },
    availableTools: request.availableTools.map((tool) => ({
      id: tool.id,
      label: tool.label,
      effect: tool.effect,
      risk: tool.risk,
      requiresApproval: tool.requiresApproval,
      inputSchema: tool.inputSchema,
    })),
    priorDecisions: checkpoint.decisions.slice(-8),
    toolResults: checkpoint.toolRecords.slice(-8).map((record) => ({
      toolId: record.call.toolId,
      status: record.outcome.status,
      output: record.outcome.output,
      evidence: [...record.outcome.evidence, ...record.outcome.verificationEvidence],
      error: record.outcome.error,
    })),
  };
}

function parseJsonDecision(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("大模型没有返回结构化 Agent 决策");
  const candidate = trimmed.slice(start, end + 1);
  if (candidate.length > 100_000) throw new Error("Agent 决策超过安全大小限制");
  return JSON.parse(candidate) as unknown;
}
