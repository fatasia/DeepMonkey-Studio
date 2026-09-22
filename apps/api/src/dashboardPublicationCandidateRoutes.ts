import type { FastifyInstance, FastifyReply } from "fastify";
import {
  assertDashboardPublicationAuthorityRequest,
  type DashboardPublicationAuthorityRequest,
} from "./dashboardPublicationAuthorityAdapter.js";
import type { DashboardNativeCandidateService } from "./dashboardNativeCandidateService.js";
import type {
  DashboardNativeCandidateRegistry,
  DashboardNativeCandidateSummary,
} from "./dashboardNativeCandidateRegistry.js";
import { httpDisconnectScope } from "./httpDisconnectScope.js";

type RouteParams = { projectId: string; applicationId: string };
type CandidateBody = {
  publicationId?: unknown;
  applicationRevision?: unknown;
  entryPageId?: unknown;
};

/**
 * The HTTP boundary accepts authority references only. Dashboard bytes, data,
 * resource closures, hashes, compiler settings, and verifier receipts remain
 * server-owned inputs to the candidate service.
 */
export async function registerDashboardPublicationCandidateRoutes(
  app: FastifyInstance,
  service?: Pick<DashboardNativeCandidateService, "prepare">,
  registry?: Pick<DashboardNativeCandidateRegistry, "register">,
  downloadFormats: readonly ("exe" | "zip" | "dmda" | "web")[] = ["dmda"],
): Promise<void> {
  app.post<{ Params: RouteParams; Body: CandidateBody }>(
    "/api/projects/:projectId/applications/:applicationId/dashboard-candidates",
    async (request, reply) => {
      if (!request.systemUser?.enabled) return reply.code(401).send({ message: "请先登录" });
      if (request.systemUser.role === "viewer") return reply.code(403).send({ message: "浏览者不能生成 Dashboard 候选版本" });
      if (request.systemUser.role !== "admin" && !request.systemUser.projectIds.includes(request.params.projectId))
        return reply.code(403).send({ message: "没有该项目的访问权限" });

      const authority = parseAuthority(request.params, request.body, reply);
      if (!authority) return reply;
      if (!service) return reply.code(503).send({ message: "Dashboard Native 候选服务未配置" });
      if (!registry) return reply.code(503).send({ message: "Dashboard Native 候选注册表未配置" });

      const disconnect = httpDisconnectScope(request.raw, reply.raw);
      try {
        const candidate = await service.prepare(
          authority,
          AbortSignal.any([disconnect.signal, AbortSignal.timeout(180_000)]),
        );
        reply.header("cache-control", "private, no-store");
        return reply.code(201).send({ ...candidateMetadata(registry.register(candidate), candidate), downloadFormats });
      } catch (reason) {
        return reply.code(409).send({
          code: candidateErrorCode(reason),
          message: "Dashboard 候选版本在校验窗口内失效，请刷新后重试",
        });
      } finally {
        disconnect.dispose();
      }
    },
  );
}

function parseAuthority(params: RouteParams, body: CandidateBody | undefined, reply: FastifyReply): DashboardPublicationAuthorityRequest | undefined {
  if (!isExactBody(body)) {
    void reply.code(400).send({ message: "请求只能包含 publicationId、applicationRevision 和 entryPageId" });
    return undefined;
  }
  const authority = {
    projectId: params.projectId,
    applicationId: params.applicationId,
    publicationId: body.publicationId,
    applicationRevision: body.applicationRevision,
    entryPageId: body.entryPageId,
  };
  try {
    assertDashboardPublicationAuthorityRequest(authority);
    return authority;
  } catch (reason) {
    void reply.code(400).send({ message: reason instanceof Error ? reason.message : "Dashboard 候选请求无效" });
    return undefined;
  }
}

function isExactBody(body: CandidateBody | undefined): body is Required<CandidateBody> {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.getPrototypeOf(body) !== Object.prototype) return false;
  const keys = Object.keys(body).sort();
  return keys.length === 3 && keys[0] === "applicationRevision" && keys[1] === "entryPageId" && keys[2] === "publicationId";
}

function candidateMetadata(
  summary: DashboardNativeCandidateSummary,
  candidate: Awaited<ReturnType<DashboardNativeCandidateService["prepare"]>>,
) {
  return {
    ...summary,
    verifier: candidate.windowVerification.verifier,
    objects: candidate.capability.objects.map(({ nodeId, status, deferredFields, reasons }) => ({
      nodeId, status, deferredFields, ...(reasons?.length ? { reasons } : {}),
    })),
  };
}

function candidateErrorCode(reason: unknown): "candidate_stale" | "candidate_timeout" | "candidate_concurrent" | "candidate_invalid" {
  if (reason instanceof DOMException && reason.name === "TimeoutError") return "candidate_timeout";
  if (reason instanceof Error && reason.name === "DashboardNativeCandidateSupersededError") return "candidate_concurrent";
  if (reason instanceof Error && reason.name === "DashboardPublicationStaleError") return "candidate_stale";
  return "candidate_invalid";
}
