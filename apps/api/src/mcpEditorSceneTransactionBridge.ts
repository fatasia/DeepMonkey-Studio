import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { SystemUserRecord } from "@bim-studio/contracts";
import type { EditorPresenceRegistry } from "./editorPresence.js";
import type { MetadataStore } from "./store.js";

/**
 * MCP 写事务桥：把 SceneCommandTransaction 的 prepare/apply/rollback 委托给浏览器
 * editor driver 执行。API 进程只做权限、会话与排队治理，绝不替浏览器校验或执行
 * 命令（命令校验在浏览器用 scene-sdk validator，执行走 ViewerSceneCommandPort）。
 * 通道是最小轮询桥：浏览器短轮询拉取请求、POST 回传结果；无 WebSocket 依赖。
 */
export const EDITOR_SCENE_TRANSACTION_TOOL = "editor.scene-transaction";

/** 固定 module：MCP 调用方不得自我声明能力/权限；studio.unity 在编辑器视口路径本就不支持，prepare 阶段即拒绝。 */
export const EDITOR_TRANSACTION_MODULE = {
  id: "mcp-editor-bridge",
  capabilities: ["studio.object", "studio.scene", "studio.camera", "studio.material", "studio.data", "studio.animation", "studio.component"],
  permissions: ["scene.read", "scene.write"],
} as const;

const TRANSACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_COMMANDS = 64;
const MAX_COMPLETED_PER_SESSION = 32;

export interface EditorDriverTransactionRequest {
  requestId: string;
  transaction: {
    id: string;
    sceneId: string;
    baseRevision: number;
    module: { id: string; capabilities: readonly string[]; permissions: readonly string[] };
    commands: readonly unknown[];
  };
}

/** 浏览器回传的 SDK outcome 信封；结构由桥校验，不合法按 failed 处理。 */
export interface EditorDriverTransactionResult {
  status: "committed" | "rolled-back" | "rejected" | "failed";
  receipt?: unknown;
  issue?: unknown;
  issues?: readonly unknown[];
}

export type EditorTransactionOutcome =
  | { readonly status: "committed"; readonly receipt: unknown }
  | { readonly status: "rolled-back"; readonly receipt: unknown; readonly issue: unknown }
  | { readonly status: "rejected"; readonly issue?: unknown; readonly issues?: readonly unknown[] }
  | { readonly status: "failed"; readonly issue: unknown }
  | { readonly status: "busy" | "timeout" | "unavailable"; readonly message: string };

interface PendingEntry {
  requestId: string;
  leaseId: string;
  expiresAt: number;
  request: EditorDriverTransactionRequest;
  resolve: (outcome: EditorTransactionOutcome) => void;
}

export interface EditorSceneTransactionBridgeOptions {
  now?: () => number;
  pendingTtlMs?: number;
  completedTtlMs?: number;
}

export class EditorSceneTransactionBridge {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly completed = new Map<string, Map<string, { outcome: EditorTransactionOutcome; at: number }>>();
  private readonly now: () => number;
  private readonly pendingTtlMs: number;
  private readonly completedTtlMs: number;

  constructor(private readonly editorPresence: EditorPresenceRegistry, private readonly store: MetadataStore, options: EditorSceneTransactionBridgeOptions = {}) {
    this.now = options.now ?? Date.now;
    this.pendingTtlMs = options.pendingTtlMs ?? 30_000;
    this.completedTtlMs = options.completedTtlMs ?? 120_000;
  }

  /** MCP 侧提交：权限/会话/排队治理后挂起等待浏览器 driver 结果。 */
  async submit(user: SystemUserRecord, sessionId: string, projectId: string, transaction: unknown): Promise<EditorTransactionOutcome> {
    const parsed = parseTransactionInput(transaction);
    if (user.role === "viewer") return { status: "unavailable", message: "viewer 角色无场景写入权限" };
    if (!parsed) return { status: "unavailable", message: "事务输入不合法：需要 id、sceneId、非负 baseRevision 和 1-64 条命令" };
    const entry = this.editorPresence.readOwned(user, sessionId);
    if (!entry || entry.surface !== "scene" || !entry.targetId) return { status: "unavailable", message: "活跃编辑器会话不存在、已过期或不在场景编辑面" };
    if (entry.projectId !== projectId) return { status: "unavailable", message: "会话不属于该项目" };
    if (!this.store.getProject(projectId)) return { status: "unavailable", message: "项目不存在" };
    if (parsed.sceneId !== entry.targetId) return { status: "unavailable", message: `事务场景 ${parsed.sceneId} 不是该编辑器当前场景 ${entry.targetId}` };
    this.prune();
    const replay = this.completed.get(sessionId)?.get(parsed.id);
    if (replay) return replay.outcome;
    if (this.pending.has(sessionId)) return { status: "busy", message: "该编辑器会话已有在途写事务，请等待其完成" };

    const request: EditorDriverTransactionRequest = {
      requestId: randomUUID(),
      transaction: { id: parsed.id, sceneId: parsed.sceneId, baseRevision: parsed.baseRevision,
        module: { id: EDITOR_TRANSACTION_MODULE.id, capabilities: [...EDITOR_TRANSACTION_MODULE.capabilities], permissions: [...EDITOR_TRANSACTION_MODULE.permissions] },
        commands: parsed.commands },
    };
    return new Promise<EditorTransactionOutcome>(resolve => {
      const timer = setTimeout(() => {
        if (this.pending.get(sessionId)?.requestId !== request.requestId) return;
        this.pending.delete(sessionId);
        resolve({ status: "timeout", message: `浏览器 editor driver 未在 ${Math.round(this.pendingTtlMs / 1000)}s 内完成事务` });
      }, this.pendingTtlMs);
      this.pending.set(sessionId, {
        requestId: request.requestId, leaseId: entry.leaseId, expiresAt: this.now() + this.pendingTtlMs, request,
        resolve: outcome => { clearTimeout(timer); resolve(outcome); },
      });
    });
  }

  /** 浏览器侧拉取：lease 不匹配或 presence 已更换会话时 fail-closed 作废在途事务。 */
  takeNext(sessionId: string, leaseId: string): EditorDriverTransactionRequest | undefined {
    this.prune();
    const pending = this.pending.get(sessionId);
    if (!pending) return undefined;
    const entry = this.editorPresence.readByLease(sessionId, leaseId);
    if (!entry || entry.leaseId !== pending.leaseId) {
      this.pending.delete(sessionId);
      pending.resolve({ status: "unavailable", message: "编辑器会话租约已更换，事务作废；请重读资源后重新提交" });
      return undefined;
    }
    return pending.request;
  }

  completeResult(sessionId: string, leaseId: string, requestId: string, result: unknown): boolean {
    const pending = this.pending.get(sessionId);
    if (!pending || pending.leaseId !== leaseId || pending.requestId !== requestId) return false;
    this.pending.delete(sessionId);
    const outcome = normalizeDriverResult(result, pending.request.transaction.id);
    let cache = this.completed.get(sessionId);
    if (!cache) { cache = new Map(); this.completed.set(sessionId, cache); }
    if (cache.size >= MAX_COMPLETED_PER_SESSION) cache.delete(cache.keys().next().value!);
    cache.set(pending.request.transaction.id, { outcome, at: this.now() });
    pending.resolve(outcome);
    return true;
  }

  private prune(): void {
    const now = this.now();
    for (const [sessionId, pending] of this.pending) {
      if (pending.expiresAt <= now) {
        this.pending.delete(sessionId);
        pending.resolve({ status: "timeout", message: "写事务等待超时" });
      }
    }
    for (const [sessionId, cache] of this.completed) {
      for (const [id, entry] of cache) if (entry.at + this.completedTtlMs <= now) cache.delete(id);
      if (cache.size === 0) this.completed.delete(sessionId);
    }
  }
}

function parseTransactionInput(value: unknown): { id: string; sceneId: string; baseRevision: number; commands: readonly unknown[] } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !TRANSACTION_ID.test(record.id)) return undefined;
  if (typeof record.sceneId !== "string" || record.sceneId.length === 0 || record.sceneId.length > 160) return undefined;
  if (typeof record.baseRevision !== "number" || !Number.isSafeInteger(record.baseRevision) || record.baseRevision < 0) return undefined;
  if (!Array.isArray(record.commands) || record.commands.length === 0 || record.commands.length > MAX_COMMANDS) return undefined;
  return { id: record.id, sceneId: record.sceneId, baseRevision: record.baseRevision, commands: [...record.commands] };
}

function normalizeDriverResult(value: unknown, transactionId: string): EditorTransactionOutcome {
  const result = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  const status = result?.status;
  if (status === "committed" || status === "rolled-back") {
    const receipt = result?.receipt;
    const valid = receipt && typeof receipt === "object" && (receipt as Record<string, unknown>).id === transactionId;
    if (valid) return status === "committed"
      ? { status: "committed", receipt }
      : { status: "rolled-back", receipt, issue: result?.issue ?? { reason: "driver-error", message: "事务被回滚" } };
  }
  if (status === "rejected" || status === "failed") {
    return status === "rejected"
      ? { status: "rejected", issue: result?.issue, ...(Array.isArray(result?.issues) ? { issues: result.issues } : {}) }
      : { status: "failed", issue: result?.issue ?? { reason: "driver-error", message: "driver 返回失败结果" } };
  }
  return { status: "failed", issue: { reason: "malformed-result", message: "浏览器 driver 返回了无法识别的事务结果" } };
}

/** 浏览器 driver 轮询通道：leaseId 证明自己是 presence 注册的那个编辑器会话。 */
export async function registerEditorSceneDriverRoutes(app: FastifyInstance, bridge: EditorSceneTransactionBridge): Promise<void> {
  app.post<{ Params: { sessionId: string }; Body: { leaseId?: string } }>("/api/editor-scene-driver/:sessionId/next", async (request, reply) => {
    const user = request.systemUser;
    if (!user) return reply.code(401).send({ message: "请先登录" });
    const leaseId = request.body?.leaseId;
    if (typeof leaseId !== "string" || leaseId.length === 0 || leaseId.length > 160) return reply.code(400).send({ message: "leaseId 无效" });
    const next = bridge.takeNext(request.params.sessionId, leaseId);
    if (!next) return reply.code(204).send();
    return reply.send(next);
  });
  app.post<{ Params: { sessionId: string }; Body: { leaseId?: string; requestId?: string; result?: unknown } }>("/api/editor-scene-driver/:sessionId/result", async (request, reply) => {
    const user = request.systemUser;
    if (!user) return reply.code(401).send({ message: "请先登录" });
    const { leaseId, requestId, result } = request.body ?? {};
    if (typeof leaseId !== "string" || leaseId.length === 0 || typeof requestId !== "string" || requestId.length === 0) {
      return reply.code(400).send({ message: "leaseId/requestId 无效" });
    }
    return bridge.completeResult(request.params.sessionId, leaseId, requestId, result)
      ? reply.code(204).send()
      : reply.code(409).send({ message: "没有匹配的在途写事务" });
  });
}

export function editorTransactionToolDefinition() {
  return {
    name: EDITOR_SCENE_TRANSACTION_TOOL,
    title: "编辑器场景写事务",
    description: "把 SceneCommandTransaction（prepare/apply/rollback）委托给当前用户的活跃浏览器编辑器执行；"
      + "baseRevision 必须来自刚读取的活跃编辑器资源，revision 漂移会被拒绝；命令在浏览器走既有 UI 命令端口，失败自动回滚。",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", minLength: 1 },
        sessionId: { type: "string", minLength: 1 },
        transaction: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$" },
            sceneId: { type: "string", minLength: 1 },
            baseRevision: { type: "integer", minimum: 0 },
            commands: { type: "array", minItems: 1, maxItems: MAX_COMMANDS, items: { type: "object" } },
          },
          required: ["id", "sceneId", "baseRevision", "commands"],
        },
      },
      required: ["projectId", "sessionId", "transaction"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        status: { type: "string", enum: ["committed", "rolled-back", "rejected", "failed", "busy", "timeout", "unavailable"] },
        capabilityId: { type: "string", enum: [EDITOR_SCENE_TRANSACTION_TOOL] },
        receipt: { type: "object", additionalProperties: true },
        issue: { type: "object", additionalProperties: true },
        issues: { type: "array", items: { type: "object", additionalProperties: true } },
        message: { type: "string" },
      },
      required: ["status", "capabilityId"],
    },
  };
}

/** MCP tools/call 的编辑器事务分支；权限与项目治理复用适配器同一套规则。 */
export async function callEditorSceneTransactionTool(
  params: Record<string, unknown> | undefined,
  bridge: EditorSceneTransactionBridge,
  request: { systemUser?: SystemUserRecord },
  id: string | number | null,
  reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } },
  modern: boolean,
) {
  const user = request.systemUser;
  if (!user) return reply.code(401).send(rpcError(id, -32001, "请先登录"));
  const args = params?.arguments;
  if (!args || typeof args !== "object") return reply.code(400).send(rpcError(id, -32602, "tools/call 需要对象 arguments"));
  const record = args as Record<string, unknown>;
  const projectId = typeof record.projectId === "string" ? record.projectId : "";
  const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
  if (!projectId || !sessionId) return reply.code(400).send(rpcError(id, -32602, "需要 projectId 与 sessionId"));
  if (user.role !== "admin" && !user.projectIds.includes(projectId)) return reply.code(403).send(rpcError(id, -32003, "当前用户无权访问该项目"));
  const outcome = await bridge.submit(user, sessionId, projectId, record.transaction);
  const structured = {
    status: outcome.status,
    capabilityId: EDITOR_SCENE_TRANSACTION_TOOL,
    ...(outcome.status === "committed" ? { receipt: outcome.receipt } : {}),
    ...(outcome.status === "rolled-back" ? { receipt: outcome.receipt, issue: outcome.issue } : {}),
    ...(outcome.status === "rejected" ? { issue: outcome.issue, ...(outcome.issues ? { issues: outcome.issues } : {}) } : {}),
    ...(outcome.status === "failed" ? { issue: outcome.issue } : {}),
    ...(outcome.status === "busy" || outcome.status === "timeout" || outcome.status === "unavailable" ? { message: outcome.message } : {}),
  };
  return { jsonrpc: "2.0" as const, id, result: {
    isError: outcome.status !== "committed",
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
    ...(modern ? { resultType: "complete" as const } : {}),
  } };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
