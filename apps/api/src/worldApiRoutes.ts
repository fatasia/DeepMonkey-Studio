import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CapabilityInvocationResult } from "@bim-studio/plugin-runtime";
import type { WorldSessionManager } from "@bim-studio/world-runtime";
import { capabilityInvocationHttpStatus } from "./capabilityInvocationReliability.js";
import type { IndustrialCapabilityHost } from "./industrialCapabilities.js";
import type { MetadataStore } from "./store.js";
import { normalizeWorldPrincipal, worldPrincipal } from "./worldApiPlugin.js";

interface WorldRouteDependencies {
  store: Pick<MetadataStore, "getProject">;
  host: IndustrialCapabilityHost;
  sessions: WorldSessionManager;
}

type ProjectParams = { Params: { projectId: string } };
type WorldParams = { Params: { projectId: string; worldId: string } };

/** World API 的 HTTP 面：每条路由只做鉴权与参数搬运，实际执行走与 MCP 相同的能力（schema/权限/超时/审计一份）。 */
export async function registerWorldApiRoutes(app: FastifyInstance, dependencies: WorldRouteDependencies): Promise<void> {
  const base = "/api/projects/:projectId/worlds";

  /** 鉴权：项目存在 → 项目访问权 → 写操作排除 viewer；返回 false 表示已回复。 */
  const authorize = async (request: FastifyRequest<ProjectParams>, reply: FastifyReply, write: boolean): Promise<boolean> => {
    const { projectId } = request.params;
    if (!await dependencies.store.getProject(projectId)) { reply.code(404).send({ message: "项目不存在" }); return false; }
    const user = request.systemUser;
    if (user && user.role !== "admin" && !user.projectIds.includes(projectId)) { reply.code(403).send({ message: "没有该项目的访问权限" }); return false; }
    if (write && user?.role === "viewer") { reply.code(403).send({ message: "浏览者只能观测与导出快照，不能改变世界" }); return false; }
    return true;
  };

  const invoke = async (request: FastifyRequest<ProjectParams>, reply: FastifyReply, capabilityId: string, input: Record<string, unknown>) => {
    const user = request.systemUser;
    const result: CapabilityInvocationResult = await dependencies.host.invoke(capabilityId, {
      requestId: randomUUID(),
      projectId: request.params.projectId,
      principal: worldPrincipal(user),
      ...(user ? { role: user.role } : {}),
      input,
    });
    if (result.status === "completed") return result;
    reply.code(worldFailureStatus(result)).send(result);
    return undefined;
  };

  /** 能力调用 + 统一回复；invoke 返回 undefined 表示已按失败状态回复。 */
  const respond = async (request: FastifyRequest<ProjectParams>, reply: FastifyReply, capabilityId: string, input: Record<string, unknown>, status = 200) => {
    const result = await invoke(request, reply, capabilityId, input);
    return result ? reply.code(status).send(result) : reply;
  };

  const body = (request: FastifyRequest): Record<string, unknown> =>
    request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};

  app.post<ProjectParams>(base, async (request, reply) => {
    if (!await authorize(request, reply, true)) return reply;
    return respond(request, reply, "world.reset", body(request), 201);
  });

  app.get<ProjectParams>(base, async (request, reply) => {
    if (!await authorize(request, reply, false)) return reply;
    const owner = { projectId: request.params.projectId, principal: normalizeWorldPrincipal(worldPrincipal(request.systemUser)) };
    return { worlds: dependencies.sessions.list(owner), limits: dependencies.sessions.limits };
  });

  app.post<ProjectParams>(`${base}/restore`, async (request, reply) => {
    if (!await authorize(request, reply, true)) return reply;
    return respond(request, reply, "world.restore", body(request));
  });

  for (const [action, write] of [["step", true], ["observe", false], ["snapshot", false]] as const) {
    app.post<WorldParams>(`${base}/:worldId/${action}`, async (request, reply) => {
      if (!await authorize(request, reply, write)) return reply;
      return respond(request, reply, `world.${action}`, { ...body(request), worldId: request.params.worldId });
    });
  }

  app.delete<WorldParams>(`${base}/:worldId`, async (request, reply) => {
    if (!await authorize(request, reply, true)) return reply;
    return respond(request, reply, "world.close", { worldId: request.params.worldId });
  });
}

/** 世界不存在/已回收 → 404；会话配额 → 429；其余调用方可修正的错误 → 422（与能力调用路由一致）。 */
function worldFailureStatus(result: CapabilityInvocationResult): number {
  const output = result.output as { error?: { code?: string } } | undefined;
  if (output?.error?.code === "not-found") return 404;
  if (output?.error?.code === "quota-exceeded") return 429;
  return capabilityInvocationHttpStatus(result);
}
