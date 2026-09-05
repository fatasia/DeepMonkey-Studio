import type { FastifyInstance, FastifyReply } from "fastify";
import { AgentRunError, type AgentApproval, type AgentBudget, type AgentCheckpoint } from "@bim-studio/industrial-agent-orchestrator";
import type { MetadataStore } from "../store.js";
import type { IndustrialAgentRuntime } from "./industrialAgentRuntime.js";

interface StartBody {
  objective?: string;
  context?: unknown;
  allowedToolIds?: string[];
  budget?: Partial<AgentBudget>;
  execution?: "background";
}

/** 路由只接收目标与预算；身份、审批人和项目范围始终从服务端会话注入。 */
export async function registerIndustrialAgentRoutes(
  app: FastifyInstance,
  dependencies: { store: Pick<MetadataStore, "getProject">; runtime: IndustrialAgentRuntime },
): Promise<void> {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/ai/agent-tools",
    async (request, reply) => dependencies.store.getProject(request.params.projectId)
      ? { tools: dependencies.runtime.tools.list() }
      : reply.code(404).send({ message: "项目不存在" }),
  );

  app.post<{ Params: { projectId: string }; Body: StartBody }>(
    "/api/projects/:projectId/ai/agent-runs",
    async (request, reply) => {
      if (!dependencies.store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
      if (request.systemUser?.role === "viewer") return reply.code(403).send({ message: "浏览者不能启动工业 Agent" });
      const objective = request.body?.objective?.trim();
      if (!objective) return reply.code(400).send({ message: "Agent 目标不能为空" });
      const available = dependencies.runtime.tools.list();
      const allowedToolIds = request.body.allowedToolIds ?? available.map((tool) => tool.id);
      const controller = new AbortController();
      const abortFromClient = () => controller.abort(new Error("客户端已断开工业 Agent 请求"));
      request.raw.once("aborted", abortFromClient);
      try {
        const startInput = {
          projectId: request.params.projectId,
          principal: request.systemUser?.id ?? "api-user",
          ...(request.systemUser ? { role: request.systemUser.role } : {}),
          objective,
          context: request.body.context ?? {},
          allowedToolIds,
          ...(request.body.budget ? { budget: request.body.budget } : {}),
        };
        const checkpoint = request.body.execution === "background"
          ? await dependencies.runtime.orchestrator.startDetached(startInput)
          : await dependencies.runtime.orchestrator.start({ ...startInput, signal: controller.signal });
        return reply.code(request.body.execution === "background" ? 202 : 201).send(checkpoint);
      } catch (error) {
        return sendAgentError(reply, error);
      } finally {
        request.raw.removeListener("aborted", abortFromClient);
      }
    },
  );

  app.get<{ Params: { projectId: string; runId: string } }>(
    "/api/projects/:projectId/ai/agent-runs/:runId",
    async (request, reply) => {
      const checkpoint = await projectCheckpoint(dependencies.runtime, request.params.projectId, request.params.runId);
      return checkpoint ?? reply.code(404).send({ message: "Agent 运行不存在" });
    },
  );

  app.post<{ Params: { projectId: string; runId: string }; Body: { scopeFingerprint?: string; execution?: "background" } }>(
    "/api/projects/:projectId/ai/agent-runs/:runId/approve",
    async (request, reply) => {
      if (request.systemUser?.role === "viewer") return reply.code(403).send({ message: "浏览者不能审批工具调用" });
      const checkpoint = await projectCheckpoint(dependencies.runtime, request.params.projectId, request.params.runId);
      if (!checkpoint) return reply.code(404).send({ message: "Agent 运行不存在" });
      const scopeFingerprint = request.body?.scopeFingerprint?.trim();
      if (!scopeFingerprint || scopeFingerprint !== checkpoint.pendingTool?.fingerprint) {
        return reply.code(409).send({ message: "审批范围与当前等待调用不一致" });
      }
      const approval: AgentApproval = {
        approvedBy: request.systemUser?.id ?? "api-approver",
        approvedAt: new Date().toISOString(),
        scopeFingerprint,
      };
      try {
        return request.body.execution === "background"
          ? await dependencies.runtime.orchestrator.resumeDetached(checkpoint.id, { approval })
          : await dependencies.runtime.orchestrator.resume(checkpoint.id, { approval });
      }
      catch (error) { return sendAgentError(reply, error); }
    },
  );

  app.post<{ Params: { projectId: string; runId: string }; Body: { execution?: "background"; expectedRevision?: number; selectionId?: string } }>(
    "/api/projects/:projectId/ai/agent-runs/:runId/resume",
    async (request, reply) => {
      if (request.systemUser?.role === "viewer") return reply.code(403).send({ message: "浏览者不能续跑工业 Agent" });
      const checkpoint = await projectCheckpoint(dependencies.runtime, request.params.projectId, request.params.runId);
      if (!checkpoint) return reply.code(404).send({ message: "Agent 运行不存在" });
      try {
        const options = {
          ...(request.body?.expectedRevision !== undefined ? { expectedRevision: request.body.expectedRevision } : {}),
          ...(request.body?.selectionId !== undefined ? { selectionId: request.body.selectionId, selectedBy: request.systemUser?.id ?? "api-user" } : {}),
        };
        return request.body?.execution === "background"
          ? await dependencies.runtime.orchestrator.resumeDetached(checkpoint.id, options)
          : await dependencies.runtime.orchestrator.resume(checkpoint.id, options);
      }
      catch (error) { return sendAgentError(reply, error); }
    },
  );

  app.delete<{ Params: { projectId: string; runId: string } }>(
    "/api/projects/:projectId/ai/agent-runs/:runId",
    async (request, reply) => {
      if (request.systemUser?.role === "viewer") return reply.code(403).send({ message: "浏览者不能取消工业 Agent" });
      const checkpoint = await projectCheckpoint(dependencies.runtime, request.params.projectId, request.params.runId);
      if (!checkpoint) return reply.code(404).send({ message: "Agent 运行不存在" });
      try { return await dependencies.runtime.orchestrator.cancel(checkpoint.id, request.systemUser?.id ?? "api-user"); }
      catch (error) { return sendAgentError(reply, error); }
    },
  );
}

async function projectCheckpoint(runtime: IndustrialAgentRuntime, projectId: string, runId: string): Promise<AgentCheckpoint | undefined> {
  const checkpoint = await runtime.orchestrator.get(runId);
  return checkpoint?.projectId === projectId ? checkpoint : undefined;
}

function sendAgentError(reply: FastifyReply, error: unknown) {
  if (error instanceof AgentRunError) {
    const status = error.code === "not-found" ? 404 : ["run-busy", "approval-mismatch", "checkpoint-conflict"].includes(error.code) ? 409 : 400;
    return reply.code(status).send({ message: error.message, code: error.code });
  }
  return reply.code(500).send({ message: error instanceof Error ? error.message : "工业 Agent 执行失败" });
}
