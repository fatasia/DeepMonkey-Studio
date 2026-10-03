import type { FastifyInstance } from "fastify";
import { auditFingerprint, createAiAuditEvent, emitAiAudit, type AiReliabilityAuditSink } from "./aiReliabilityAudit.js";

/**
 * 助手场景改动闭环(计划→执行→验证)的审计落账。浏览器在应用/回滚/验证/撤销时回传回执,
 * 这里只存指纹与判定(同既有 AI 审计:不含提示词、命令参数或截图原文),并绑定到持久化审计链。
 * 模型调用本身已由 /api/ai/assistant 审计;本路由补齐"改了什么场景、是否验证、是否撤销"。
 */
const EVENTS = ["applied", "rolled-back", "verified", "undone"] as const;
type SceneEditEvent = (typeof EVENTS)[number];
const FINGERPRINT = /^[0-9a-f]{8,64}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;

interface SceneEditRecordBody {
  sessionId: string;
  round: number;
  event: SceneEditEvent;
  mode: "plan" | "confirm" | "autonomous";
  planFingerprint: string;
  commandCount: number;
  receiptId?: string;
  checks?: { total: number; failed: number };
  viewportFingerprint?: string;
  verdict?: { outcome: "achieved" | "unachieved" | "unverified"; source: "model" | "checks" };
}

export async function registerSceneEditAuditRoutes(
  app: FastifyInstance,
  dependencies: { store: Pick<import("../store.js").MetadataStore, "getProject">; audit?: AiReliabilityAuditSink },
): Promise<void> {
  app.post<{ Params: { projectId: string }; Body: unknown }>("/api/projects/:projectId/ai/scene-edit-records", async (request, reply) => {
    const user = request.systemUser;
    if (user?.role === "viewer") return reply.code(403).send({ message: "浏览者不能记录场景改动" });
    if (!await dependencies.store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    const body = parse(request.body);
    if (typeof body === "string") return reply.code(400).send({ message: body });
    const failed = body.event === "rolled-back";
    const degraded = body.event === "verified" && body.verdict?.outcome !== "achieved";
    const event = createAiAuditEvent({
      traceId: `scene-edit:${body.sessionId}:${body.round}`,
      stage: "tool-result",
      outcome: failed ? "failed" : degraded ? "degraded" : "completed",
      principal: user?.id ?? "api-user",
      projectId: request.params.projectId,
      tool: {
        id: `scene.edit.${body.event}`,
        risk: "medium",
        resourceFingerprints: [body.planFingerprint, ...(body.viewportFingerprint ? [body.viewportFingerprint] : [])],
      },
      inputFingerprint: auditFingerprint(body),
      ...(failed ? { failure: { code: "scene-edit-rolled-back", message: "场景改动整批回滚", retryable: true } } : {}),
    });
    await emitAiAudit(dependencies.audit, event, true);
    return reply.code(202).send({ eventId: event.eventId, evidenceFingerprint: event.evidenceFingerprint });
  });
}

function parse(input: unknown): SceneEditRecordBody | string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "请求必须为对象";
  const body = input as Record<string, unknown>;
  if (typeof body.sessionId !== "string" || !ID.test(body.sessionId)) return "sessionId 无效";
  if (!Number.isInteger(body.round) || (body.round as number) < 1 || (body.round as number) > 16) return "round 无效";
  if (!EVENTS.includes(body.event as SceneEditEvent)) return "event 无效";
  if (!["plan", "confirm", "autonomous"].includes(body.mode as string)) return "mode 无效";
  if (typeof body.planFingerprint !== "string" || !FINGERPRINT.test(body.planFingerprint)) return "planFingerprint 无效";
  if (!Number.isInteger(body.commandCount) || (body.commandCount as number) < 0 || (body.commandCount as number) > 64) return "commandCount 无效";
  if (body.receiptId !== undefined && (typeof body.receiptId !== "string" || !ID.test(body.receiptId))) return "receiptId 无效";
  if (body.viewportFingerprint !== undefined && (typeof body.viewportFingerprint !== "string" || !FINGERPRINT.test(body.viewportFingerprint))) return "viewportFingerprint 无效";
  const checks = body.checks as { total?: unknown; failed?: unknown } | undefined;
  if (checks !== undefined && (!checks || !Number.isInteger(checks.total) || !Number.isInteger(checks.failed))) return "checks 无效";
  const verdict = body.verdict as { outcome?: unknown; source?: unknown } | undefined;
  if (verdict !== undefined && (!verdict || !["achieved", "unachieved", "unverified"].includes(verdict.outcome as string) || !["model", "checks"].includes(verdict.source as string))) return "verdict 无效";
  return {
    sessionId: body.sessionId, round: body.round as number, event: body.event as SceneEditEvent, mode: body.mode as SceneEditRecordBody["mode"],
    planFingerprint: body.planFingerprint, commandCount: body.commandCount as number,
    ...(body.receiptId ? { receiptId: body.receiptId as string } : {}),
    ...(checks ? { checks: { total: checks.total as number, failed: checks.failed as number } } : {}),
    ...(body.viewportFingerprint ? { viewportFingerprint: body.viewportFingerprint as string } : {}),
    ...(verdict ? { verdict: verdict as SceneEditRecordBody["verdict"] & object } : {}),
  };
}
