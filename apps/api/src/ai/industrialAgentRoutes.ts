import type { FastifyInstance, FastifyReply } from "fastify";
import { AgentRunError, type AgentApproval, type AgentBudget, type AgentCheckpoint } from "@bim-studio/industrial-agent-orchestrator";
import type { MetadataStore } from "../store.js";
import { OntologyPackageStore } from "../ontology/ontologyStore.js";
import type { IndustrialAgentRuntime } from "./industrialAgentRuntime.js";
import { AssistantSessionOptionError, type AssistantSessionOptions } from "./assistantSessionOptions.js";
import {
  OntologyActionRejectionError,
  OntologyActionRuntimeError,
  validateOntologyActionQuery,
  type OntologyActionPlanInput,
} from "@bim-studio/contracts";
import {
  createOntologyActionService,
  isOntologyActionRejection,
  resolveOntologyActionLedger,
  type OntologyActionService,
} from "./ontologyActionService.js";

interface StartBody {
  objective?: string;
  context?: unknown;
  allowedToolIds?: string[];
  budget?: Partial<AgentBudget>;
  execution?: "background";
  modelOptions?: AssistantSessionOptions;
  /** H-C1 plan 档：true 时工具面收敛为 read/analyze，finish 不允许 production 结论。 */
  planMode?: boolean;
}

/**
 * 路由只接收目标与预算；身份、审批人和项目范围始终从服务端会话注入。
 * H-C4-P3：本体行动路径端点挂在同一 Harness 路由模块（计划→预览→执行→回执）。
 */
export async function registerIndustrialAgentRoutes(
  app: FastifyInstance,
  dependencies: {
    store: Pick<MetadataStore, "getProject">;
    runtime: IndustrialAgentRuntime;
    /** 测试直注；生产由 runtime.dataDir + 共享账本懒装配（见 createOntologyActionRoutes）。 */
    ontologyActionService?: OntologyActionService;
  },
): Promise<void> {
  // Retries share the durable stop operation, including requests arriving before its write completes.
  const cancellations = new Map<string, Promise<AgentCheckpoint>>();
  await registerOntologyActionRoutes(app, dependencies.store, dependencies.runtime, dependencies.ontologyActionService);
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
      const objective = typeof request.body?.objective === "string" ? request.body.objective.trim() : "";
      if (!objective) return reply.code(400).send({ message: "Agent 目标不能为空" });
      const available = dependencies.runtime.tools.list();
      const allowedToolIds = request.body.allowedToolIds ?? available.map((tool) => tool.id);
      const controller = new AbortController();
      const abortFromClient = () => controller.abort(new Error("客户端已断开工业 Agent 请求"));
      request.raw.once("aborted", abortFromClient);
      try {
        const options = request.body.modelOptions;
        if (options !== undefined && (!options || typeof options !== "object" || Array.isArray(options))) {
          throw new AssistantSessionOptionError("会话模型参数无效");
        }
        if (options && !dependencies.runtime.resolveModelOptions) throw new AssistantSessionOptionError("当前运行环境未配置会话模型选择");
        const modelOptions = dependencies.runtime.resolveModelOptions ? await dependencies.runtime.resolveModelOptions(options ?? {}) : undefined;
        const startInput = {
          projectId: request.params.projectId,
          principal: request.systemUser?.id ?? "api-user",
          ...(request.systemUser ? { role: request.systemUser.role } : {}),
          objective,
          ...(modelOptions ? { modelOptions } : {}),
          context: request.body.context ?? {},
          allowedToolIds,
          ...(request.body.planMode === true ? { planMode: true } : {}),
          ...(request.body.budget ? { budget: request.body.budget } : {}),
        };
        const checkpoint = request.body.execution === "background"
          ? await dependencies.runtime.orchestrator.startDetached(startInput)
          : await dependencies.runtime.orchestrator.start({ ...startInput, signal: controller.signal });
        return reply.code(request.body.execution === "background" ? 202 : 201).send(checkpoint);
      } catch (error) {
        if (error instanceof AssistantSessionOptionError) return reply.code(400).send({ message: error.message });
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
      try {
        let cancellation = cancellations.get(checkpoint.id);
        if (!cancellation) {
          cancellation = dependencies.runtime.orchestrator.cancel(checkpoint.id, request.systemUser?.id ?? "api-user");
          cancellations.set(checkpoint.id, cancellation);
        }
        try { return await cancellation; }
        finally { if (cancellations.get(checkpoint.id) === cancellation) cancellations.delete(checkpoint.id); }
      }
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

// ---------------------------------------------------------------------------
// H-C4-P3 本体行动路径：计划 → 预览 → 执行 → 回执（三跳链）
// ---------------------------------------------------------------------------

/**
 * 生产装配：本体包读取器按请求构造（dataDir 下新建只读 store 实例，读档即最新发布状态，
 * 不与数据中心工作区的写实例共享缓存）；账本为共享单例（经 registerProvenanceRoutes 绑入）。
 * 装配缺口（无 dataDir）时行动面整体 503 fail-closed，不降级放行。
 */
function createOntologyActionRoutes(runtime: IndustrialAgentRuntime): OntologyActionService | undefined {
  if (!runtime.dataDir) return undefined;
  return createOntologyActionService({
    ontologyReader: () => new OntologyPackageStore(runtime.dataDir),
    ledger: resolveOntologyActionLedger,
    tools: runtime.tools,
  });
}

async function registerOntologyActionRoutes(
  app: FastifyInstance,
  store: Pick<MetadataStore, "getProject">,
  runtime: IndustrialAgentRuntime,
  injected?: OntologyActionService,
): Promise<void> {
  const actions = injected ?? createOntologyActionRoutes(runtime);

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/ai/ontology-actions",
    async (request, reply) => {
      if (!await store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
      if (!actions) return reply.code(503).send({ code: "ontology-runtime-unavailable", message: "本体行动运行时不可用（fail-closed）" });
      return { actions: await actions.listPublishedActions(request.params.projectId) };
    },
  );

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    "/api/projects/:projectId/ai/ontology-actions/preview",
    async (request, reply) => {
      if (!await store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
      if (!actions) return reply.code(503).send({ code: "ontology-runtime-unavailable", message: "本体行动运行时不可用（fail-closed）" });
      let planInput: OntologyActionPlanInput;
      try {
        planInput = parsePlanInput(request.body);
      } catch (error) {
        return reply.code(400).send({ message: error instanceof Error ? error.message : "行动计划无效" });
      }
      try {
        return await actions.preview(request.params.projectId, planInput, {
          principal: request.systemUser?.id ?? "api-user",
          ...(request.systemUser?.role ? { role: request.systemUser.role } : {}),
        });
      } catch (error) {
        return ontologyActionError(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    "/api/projects/:projectId/ai/ontology-actions/execute",
    async (request, reply) => {
      if (!await store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
      if (request.systemUser?.role === "viewer") return reply.code(403).send({ message: "浏览者不能执行本体行动" });
      if (!actions) return reply.code(503).send({ code: "ontology-runtime-unavailable", message: "本体行动运行时不可用（fail-closed）" });
      let planInput: OntologyActionPlanInput;
      let approval: AgentApproval | undefined;
      try {
        const body = recordBody(request.body);
        planInput = parsePlanInput(body);
        approval = parseApproval(body, request.systemUser?.id ?? "api-approver");
      } catch (error) {
        return reply.code(400).send({ message: error instanceof Error ? error.message : "行动计划无效" });
      }
      try {
        const outcome = await actions.execute(request.params.projectId, planInput, {
          principal: request.systemUser?.id ?? "api-user",
          ...(request.systemUser?.role ? { role: request.systemUser.role } : {}),
          ...(approval ? { approval } : {}),
        });
        if (outcome.status === "rejected") return reply.code(409).send(outcome);
        if (outcome.status === "blocked") return reply.code(409).send(outcome);
        return outcome;
      } catch (error) {
        return ontologyActionError(reply, error);
      }
    },
  );

  app.get<{ Params: { projectId: string }; Querystring: Record<string, string | undefined> }>(
    "/api/projects/:projectId/ai/ontology-actions/trace",
    async (request, reply) => {
      if (!await store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
      if (!actions) return reply.code(503).send({ code: "ontology-runtime-unavailable", message: "本体行动运行时不可用（fail-closed）" });
      const ledger = resolveOntologyActionLedger();
      if (!ledger) return reply.code(503).send({ code: "ontology-runtime-unavailable", message: "行动回执账本未绑定（fail-closed）" });
      try {
        const query = request.query;
        const limit = query.limit === undefined ? undefined : Number(query.limit);
        if (query.limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100)) {
          return reply.code(400).send({ message: "limit 必须是 1 至 100 的整数" });
        }
        return await ledger.traceActionChains(request.params.projectId, validateOntologyActionQuery({
          ...(query.planFingerprint ? { planFingerprint: query.planFingerprint } : {}),
          ...(query.receiptFingerprint ? { receiptFingerprint: query.receiptFingerprint } : {}),
          ...(query.idempotencyKey ? { idempotencyKey: query.idempotencyKey } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }));
      } catch (error) {
        return ontologyActionError(reply, error);
      }
    },
  );
}

/** 拒绝/装配错误 → 结构化响应：理由码必须显式出现在响应体，客户端不得从 message 反推。 */
function ontologyActionError(reply: FastifyReply, error: unknown) {
  if (isOntologyActionRejection(error)) return reply.code(422).send({ code: error.code, message: error.message });
  if (error instanceof OntologyActionRuntimeError) return reply.code(503).send({ code: error.code, message: error.message });
  return reply.code(500).send({ message: error instanceof Error ? error.message : "本体行动执行失败" });
}

function recordBody(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("请求体必须是对象");
  return input as Record<string, unknown>;
}

function parsePlanInput(body: unknown): OntologyActionPlanInput {
  const source = recordBody(body);
  const actionKey = typeof source.actionKey === "string" ? source.actionKey.trim() : "";
  if (!actionKey) throw new Error("actionKey 不能为空");
  const targetSource = recordBody(source.target);
  const objectKey = typeof targetSource.objectKey === "string" ? targetSource.objectKey.trim() : "";
  const canonicalId = typeof targetSource.canonicalId === "string" ? targetSource.canonicalId.trim() : "";
  if (!objectKey || !canonicalId) throw new Error("行动目标必须包含 objectKey 与 canonicalObjectId");
  const args = source.arguments ?? {};
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("行动参数必须是对象");
  return {
    ...(typeof source.packageId === "string" && source.packageId.trim() ? { packageId: source.packageId.trim() } : {}),
    actionKey,
    target: { objectKey, canonicalId },
    arguments: args as Record<string, unknown>,
    ...(typeof source.scope === "string" && source.scope.trim() ? { scope: source.scope.trim() } : {}),
    ...(typeof source.idempotencyKey === "string" && source.idempotencyKey.trim() ? { idempotencyKey: source.idempotencyKey.trim() } : {}),
  };
}

/** 审批人身份与服务端时间一律取会话，客户端只回传审批范围指纹（对齐 agent-runs 审批纪律）。 */
function parseApproval(body: Record<string, unknown>, approver: string): AgentApproval | undefined {
  const source = body.approval;
  if (source === undefined || source === null) return undefined;
  const record = recordBody(source);
  const scopeFingerprint = typeof record.scopeFingerprint === "string" ? record.scopeFingerprint.trim() : "";
  if (!scopeFingerprint) throw new Error("审批缺少 scopeFingerprint");
  return { approvedBy: approver, approvedAt: new Date().toISOString(), scopeFingerprint };
}
