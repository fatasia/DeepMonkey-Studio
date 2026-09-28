import type { FastifyInstance, FastifyReply } from "fastify";
import { createAiAuditEvent, emitAiAudit, type AiReliabilityAuditSink } from "./aiReliabilityAudit.js";
import {
  AgentMemoryLimitError,
  AgentMemoryNotFoundError,
  type AgentMemoryStore,
} from "./agentMemory.js";

interface MemoryPatchBody {
  content?: string;
  enabled?: boolean;
}

/**
 * H-C2 记忆面板路由（用户可感知载体）：条目列表/来源/确认/启停/编辑/删除。
 * RULES.md 是人写守则，这里只读（configured + 摘要），编辑走文件系统。
 * 全部写操作落 memory-action 审计事件；浏览者只读。
 */
export async function registerAgentMemoryRoutes(
  app: FastifyInstance,
  dependencies: {
    store: Pick<import("../store.js").MetadataStore, "getProject">;
    memory: AgentMemoryStore;
    audit?: AiReliabilityAuditSink;
  },
): Promise<void> {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/ai/memory",
    async (request, reply) => {
      if (!await projectExists(dependencies.store, request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
      const [rules, memories] = await Promise.all([
        dependencies.memory.rulesSummary(request.params.projectId),
        dependencies.memory.listMemories(request.params.projectId),
      ]);
      return { rules, memories };
    },
  );

  app.post<{ Params: { projectId: string; memoryId: string } }>(
    "/api/projects/:projectId/ai/memory/:memoryId/confirm",
    async (request, reply) => {
      if (request.systemUser?.role === "viewer") return reply.code(403).send({ message: "浏览者不能确认记忆条目" });
      if (!await projectExists(dependencies.store, request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
      try {
        const record = await dependencies.memory.confirmMemory(
          request.params.projectId,
          request.params.memoryId,
          request.systemUser?.id ?? "api-user",
        );
        await emitMemoryAction(dependencies.audit, request, "confirm", record.id, record.status);
        return record;
      } catch (error) { return sendMemoryError(reply, error); }
    },
  );

  app.patch<{ Params: { projectId: string; memoryId: string }; Body: MemoryPatchBody }>(
    "/api/projects/:projectId/ai/memory/:memoryId",
    async (request, reply) => {
      if (request.systemUser?.role === "viewer") return reply.code(403).send({ message: "浏览者不能修改记忆条目" });
      if (!await projectExists(dependencies.store, request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
      const body = request.body ?? {};
      if (body.content === undefined && body.enabled === undefined) {
        return reply.code(400).send({ message: "记忆更新需要 content 或 enabled 之一" });
      }
      if (body.content !== undefined && (typeof body.content !== "string" || !body.content.trim())) {
        return reply.code(400).send({ message: "记忆内容不能为空" });
      }
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
        return reply.code(400).send({ message: "enabled 必须是布尔值" });
      }
      try {
        const record = await dependencies.memory.updateMemory(request.params.projectId, request.params.memoryId, {
          ...(body.content !== undefined ? { content: body.content } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        });
        await emitMemoryAction(dependencies.audit, request, body.enabled === false ? "disable" : body.enabled === true ? "enable" : "edit", record.id, record.status);
        return record;
      } catch (error) { return sendMemoryError(reply, error); }
    },
  );

  app.delete<{ Params: { projectId: string; memoryId: string } }>(
    "/api/projects/:projectId/ai/memory/:memoryId",
    async (request, reply) => {
      if (request.systemUser?.role === "viewer") return reply.code(403).send({ message: "浏览者不能删除记忆条目" });
      if (!await projectExists(dependencies.store, request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
      try {
        await dependencies.memory.deleteMemory(request.params.projectId, request.params.memoryId);
        await emitMemoryAction(dependencies.audit, request, "delete", request.params.memoryId, "deleted");
        return reply.code(200).send({ deleted: request.params.memoryId });
      } catch (error) { return sendMemoryError(reply, error); }
    },
  );
}

async function projectExists(store: Pick<import("../store.js").MetadataStore, "getProject">, projectId: string): Promise<boolean> {
  return Boolean(await store.getProject(projectId));
}

type MemoryAction = "confirm" | "enable" | "disable" | "edit" | "delete";

interface MemoryRequestLike {
  params: { projectId: string };
  systemUser?: { id?: string; role?: string };
}

/** 记忆操作审计：只记动作、条目 ID 与结果状态，不复制记忆内容原文。 */
async function emitMemoryAction(
  audit: AiReliabilityAuditSink | undefined,
  request: MemoryRequestLike,
  action: MemoryAction,
  memoryId: string,
  resultStatus: string,
): Promise<void> {
  if (!audit) return;
  await emitAiAudit(audit, createAiAuditEvent({
    traceId: `memory:${request.params.projectId}:${memoryId}`,
    stage: "memory-action",
    outcome: "completed",
    principal: request.systemUser?.id ?? "api-user",
    projectId: request.params.projectId,
    findings: [{
      code: `memory:${action}`,
      severity: "info",
      sourceId: memoryId,
      contentFingerprint: resultStatus,
    }],
    inputFingerprint: `${action}:${memoryId}:${resultStatus}`,
  }));
}

function sendMemoryError(reply: FastifyReply, error: unknown) {
  if (error instanceof AgentMemoryNotFoundError) return reply.code(404).send({ message: error.message, code: error.code });
  if (error instanceof AgentMemoryLimitError) return reply.code(409).send({ message: error.message, code: error.code });
  return reply.code(500).send({ message: error instanceof Error ? error.message : "记忆操作失败" });
}
