import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AiContextDelivery, AiSessionMessageInput, AiSessionReliability } from "@bim-studio/contracts";
import { AssistantSessionError, AssistantSessionStore } from "./assistantSessionStore.js";

const ROOT = "/api/projects/:projectId/ai/assistant-sessions";
const modes = ["platform", "operations", "vision", "bim", "scene", "component", "dashboard", "sql"];
export async function registerAssistantSessionRoutes(app: FastifyInstance, store: AssistantSessionStore, projectExists: (id: string) => boolean) {
  const handler = (action: (request: FastifyRequest, owner: string, project: string, params: Record<string, string>) => unknown) => async (request: FastifyRequest, reply: import("fastify").FastifyReply) => {
    reply.header("cache-control", "private, no-store");
    try {
      const user = request.systemUser;
      if (!user) throw new AssistantSessionError(401, "请先登录");
      const params = request.params as Record<string, string>;
      const project = params.projectId!;
      if (user.role !== "admin" && !user.projectIds.includes(project)) throw new AssistantSessionError(403, "没有该项目的访问权限");
      if (!projectExists(project)) throw new AssistantSessionError(404, "项目不存在");
      if (params.sessionId) id(params.sessionId);
      if (params.messageId) id(params.messageId);
      return await action(request, user.id, project, params);
    } catch (error) {
      if (error instanceof AssistantSessionError) return reply.code(error.status).send({ message: error.message });
      throw error;
    }
  };
  app.get(ROOT, handler((request, owner, project) => { const page = pagination(request.query); return store.list(owner, project, page.after, page.limit); }));
  app.put(`${ROOT}/:sessionId`, handler((request, owner, project, params) => {
    const body = record(request.body); const title = text(body.title, "标题", 120);
    return store.create(owner, project, params.sessionId!, title);
  }));
  app.get(`${ROOT}/:sessionId/messages`, handler((request, owner, project, params) => {
    const page = pagination(request.query); return store.messages(owner, project, params.sessionId!, page.after, page.limit);
  }));
  app.put(`${ROOT}/:sessionId/messages/:messageId`, { bodyLimit: 512 * 1024 }, handler((request, owner, project, params) =>
    store.putMessage(owner, project, params.sessionId!, params.messageId!, messageInput(request.body))));
}
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AssistantSessionError(400, "请求必须为对象");
  return input as Record<string, unknown>;
}
function text(value: unknown, name: string, max: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max) throw new AssistantSessionError(400, `${name}长度无效（最多 ${max} 个字符）`);
  return value;
}
function id(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new AssistantSessionError(400, "标识无效");
  return value;
}
function pagination(value: unknown): { after: string | undefined; limit: number } {
  const query = record(value); const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new AssistantSessionError(400, "分页条数必须为 1 至 50");
  return { after: query.after === undefined ? undefined : id(text(query.after, "游标", 128)), limit };
}
function messageInput(value: unknown): AiSessionMessageInput {
  const body = record(value);
  if (!Number.isSafeInteger(body.sequence) || Number(body.sequence) < 1) throw new AssistantSessionError(400, "消息序号必须为正整数");
  if (typeof body.mode !== "string" || !modes.includes(body.mode) || typeof body.status !== "string" || !["streaming", "completed", "stopped", "failed"].includes(body.status)) throw new AssistantSessionError(400, "消息模式或状态无效");
  return { sequence: Number(body.sequence), question: text(body.question, "问题", 4000), answer: text(body.answer, "回答", 100_000, true),
    mode: body.mode as AiSessionMessageInput["mode"], status: body.status as AiSessionMessageInput["status"],
    ...(body.model === undefined ? {} : { model: text(body.model, "模型", 256) }),
    ...(body.execution === undefined ? {} : { execution: executionInput(body.execution) }),
    ...(body.reliability === undefined ? {} : { reliability: reliabilityInput(body.reliability) }),
    ...(body.scope === undefined ? {} : { scope: text(body.scope, "对象标识", 256) }),
  };
}

function reliabilityInput(value: unknown): AiSessionReliability {
  const body = record(value);
  const grade = oneOf(body.grade, ["capability-verified", "context-supported", "limited", "unverified"], "可靠性等级");
  const contextTrust = oneOf(body.contextTrust, ["client-snapshot", "server-evidence", "capability-result"], "证据来源");
  const inputRisk = oneOf(body.inputRisk, ["low", "medium", "high"], "输入风险");
  const writePolicy = oneOf(body.writePolicy, ["read-only", "confirm-required"], "写入策略");
  const evidenceCount = integer(body.evidenceCount, "证据数量", 0, 100_000);
  const warnings = stringArray(body.warnings, "警告", 64, 400);
  const sourceLabels = stringArray(body.sourceLabels, "来源标签", 128, 400);
  const contextSourceLabels = body.contextSourceLabels === undefined ? undefined : stringMap(body.contextSourceLabels, "来源映射", 128, 400);
  const traceId = body.traceId === undefined ? undefined : text(body.traceId, "Trace", 256);
  const contextFingerprint = body.contextFingerprint === undefined ? undefined : text(body.contextFingerprint, "证据指纹", 256);
  const fallbackReason = body.fallbackReason === undefined ? undefined : oneOf(body.fallbackReason, ["no-capability-evidence"], "降级原因");
  return {
    grade, contextTrust, inputRisk, writePolicy, evidenceCount, warnings, sourceLabels,
    ...(contextSourceLabels ? { contextSourceLabels } : {}),
    ...(traceId ? { traceId } : {}), ...(contextFingerprint ? { contextFingerprint } : {}),
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(body.contextDelivery === undefined ? {} : { contextDelivery: contextDeliveryInput(body.contextDelivery) }),
  };
}

function contextDeliveryInput(value: unknown): AiContextDelivery {
  const body = record(value);
  if (body.unit !== "utf16") throw new AssistantSessionError(400, "上下文计量单位无效");
  const preparedChars = integer(body.preparedChars, "准备上下文字符数", 0, 10_000_000);
  const sentChars = integer(body.sentChars, "发送上下文字符数", 0, preparedChars);
  if (!Array.isArray(body.sources) || body.sources.length > 128) throw new AssistantSessionError(400, "上下文来源数量无效");
  const sources = body.sources.map((item) => {
    const source = record(item);
    const status = oneOf(source.status, ["sent", "partial", "omitted"], "上下文来源状态");
    return {
      id: text(source.id, "上下文来源 ID", 128), path: text(source.path, "上下文来源路径", 256), status,
      preparedChars: integer(source.preparedChars, "来源准备字符数", 0, 10_000_000),
      sentChars: integer(source.sentChars, "来源发送字符数", 0, 10_000_000),
      transformed: source.transformed === true,
    };
  });
  return { unit: "utf16", preparedChars, sentChars, sources };
}

function oneOf<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new AssistantSessionError(400, `${name}无效`);
  return value as T;
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new AssistantSessionError(400, `${name}无效`);
  return Number(value);
}

function stringArray(value: unknown, name: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new AssistantSessionError(400, `${name}无效`);
  return value.map((item) => text(item, name, maxLength));
}

function stringMap(value: unknown, name: string, maxItems: number, maxLength: number): Record<string, string> {
  const body = record(value); const entries = Object.entries(body);
  if (entries.length > maxItems) throw new AssistantSessionError(400, `${name}无效`);
  return Object.fromEntries(entries.map(([key, item]) => [text(key, `${name}键`, 128), text(item, name, maxLength)]));
}

function executionInput(value: unknown): NonNullable<AiSessionMessageInput["execution"]> {
  const body = record(value);
  if (body.protocol !== "responses" && body.protocol !== "chat-completions") throw new AssistantSessionError(400, "模型协议无效");
  if (body.servedBy !== undefined && body.servedBy !== "primary" && body.servedBy !== "fallback") throw new AssistantSessionError(400, "模型来源无效");
  if (body.failoverCategory !== undefined && (body.servedBy !== "fallback" || !["quota", "rate-limit", "server", "timeout", "network"].includes(String(body.failoverCategory)))) throw new AssistantSessionError(400, "备用切换原因无效");
  return { protocol: body.protocol, requestedModel: text(body.requestedModel, "请求模型", 256),
    ...(body.servedBy === undefined ? {} : { servedBy: body.servedBy }),
    ...(body.failoverCategory === undefined ? {} : { failoverCategory: String(body.failoverCategory) }),
    ...(body.reportedModel === undefined ? {} : { reportedModel: text(body.reportedModel, "返回模型", 256) }),
    ...(body.reasoningEffortSent === undefined ? {} : { reasoningEffortSent: text(body.reasoningEffortSent, "发送档位", 64) }),
    ...(body.reasoningEffortReported === undefined ? {} : { reasoningEffortReported: text(body.reasoningEffortReported, "返回档位", 64) }),
  };
}
