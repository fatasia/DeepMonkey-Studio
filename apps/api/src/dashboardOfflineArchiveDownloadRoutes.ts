import type { FastifyInstance } from "fastify";
import path from "node:path";
import { createDashboardPortableZip } from "./dashboardPortableZip.js";
import {
  createDashboardOfflineArchive,
  type DashboardOfflineArchiveV1,
} from "./dashboardOfflineArchive.js";
import { serializeDashboardOfflineArchive } from "./dashboardOfflineArchiveBytes.js";
import type { DashboardPublicationFreezeManifest } from "./dashboardPublicationFreeze.js";
import {
  DashboardNativeCandidateAuthorityError,
  DashboardNativeCandidateExpiredError,
  DashboardNativeCandidateNotFoundError,
  type DashboardNativeCandidateRecord,
  type DashboardNativeCandidateRegistry,
} from "./dashboardNativeCandidateRegistry.js";

type RouteParams = { readonly projectId: string; readonly applicationId: string; readonly candidateId: string };

export interface DashboardOfflineArchiveDownloadDependencies {
  /** Candidate records are private; routes may read them only through this scoped port. */
  readonly registry: Pick<DashboardNativeCandidateRegistry, "read">;
  /** Resolves the C3 manifest from the server-only candidate record, never from HTTP input. */
  readonly readFreezeManifest: (input: {
    readonly record: DashboardNativeCandidateRecord;
    readonly signal?: AbortSignal;
  }) => Promise<DashboardPublicationFreezeManifest | undefined>;
  readonly createArchive?: (input: {
    readonly freezeManifest: DashboardPublicationFreezeManifest;
    readonly capability: DashboardNativeCandidateRecord["candidate"]["capability"];
    readonly artifact: Uint8Array;
  }) => DashboardOfflineArchiveV1;
  readonly serializeArchive?: (archive: DashboardOfflineArchiveV1) => Uint8Array;
  /** 部署固定播放器路径；HTTP 参数不能选择或覆盖它。未配置时不注册 ZIP 路由。 */
  readonly portable?: {
    readonly nativeExecutable: string;
    readonly createZip?: typeof createDashboardPortableZip;
  };
}

/**
 * Serves a verified, short-lived C5 candidate as DMDA or deployment-enabled ZIP.
 * This module deliberately does not register itself in the global route index,
 * so composition owns the concrete store and identity integrations.
 */
export async function registerDashboardOfflineArchiveDownloadRoutes(
  app: FastifyInstance,
  dependencies: DashboardOfflineArchiveDownloadDependencies,
): Promise<void> {
  const portable = dependencies.portable;
  const executable = portable?.nativeExecutable;
  if (portable && (!executable || !path.isAbsolute(executable) || path.extname(executable).toLowerCase() !== ".exe")) {
    throw new Error("Dashboard portable download requires an absolute .exe path");
  }
  const createZip = portable?.createZip ?? createDashboardPortableZip;
  for (const format of portable ? ["dmda", "zip"] : ["dmda"]) {
  app.get<{ Params: RouteParams }>(
    `/api/projects/:projectId/applications/:applicationId/dashboard-candidates/:candidateId/${format === "zip" ? "portable-zip" : "offline-archive"}`,
    async (request, reply) => {
      if (!request.systemUser?.enabled) return reply.code(401).send({ message: "请先登录" });
      if (request.systemUser.role === "viewer") return reply.code(403).send({ message: "浏览者不能下载 Dashboard 候选离线包" });
      if (request.systemUser.role !== "admin" && !request.systemUser.projectIds.includes(request.params.projectId)) {
        return reply.code(403).send({ message: "没有该项目的访问权限" });
      }
      if (format === "zip" && Object.keys(request.query as object).length !== 0) {
        return reply.code(400).send({ message: "Dashboard ZIP 下载不接受查询参数" });
      }

      let record: DashboardNativeCandidateRecord;
      try {
        record = dependencies.registry.read({
          candidateId: request.params.candidateId,
          projectId: request.params.projectId,
          applicationId: request.params.applicationId,
        });
      } catch (reason) {
        return sendLookupFailure(reply, reason);
      }

      try {
        const freezeManifest = await dependencies.readFreezeManifest({
          record,
          signal: request.signal,
        });
        if (!freezeManifest) return reply.code(409).send({ code: "candidate_invalid", message: "Dashboard 候选离线包已失效，请刷新后重试" });
        const archive = (dependencies.createArchive ?? createDashboardOfflineArchive)({
          freezeManifest,
          capability: record.candidate.capability,
          artifact: record.candidate.artifact.artifact,
        });
        const archiveBytes = (dependencies.serializeArchive ?? serializeDashboardOfflineArchive)(archive);
        request.signal.throwIfAborted();
        const bytes = format === "zip"
          ? await createZip(archiveBytes, executable!, { signal: request.signal })
          : archiveBytes;
        request.signal.throwIfAborted();
        // 清单读取及 ZIP 压缩均可能等待；发送前重查 TTL 和候选撤销状态。
        try {
          dependencies.registry.read({ candidateId: request.params.candidateId,
            projectId: request.params.projectId, applicationId: request.params.applicationId });
        } catch (reason) { return sendLookupFailure(reply, reason); }
        return reply
          .header("cache-control", "private, no-store")
          .header("content-disposition", `attachment; filename="dashboard-candidate-${safeFileId(record.summary.candidateId)}.${format}"`)
          .header("content-length", String(bytes.byteLength))
          .header("x-content-type-options", "nosniff")
          .type(format === "zip" ? "application/zip" : "application/octet-stream")
          .send(Buffer.from(bytes));
      } catch {
        return reply.code(409).send({ code: "candidate_invalid", message: "Dashboard 候选离线包已失效，请刷新后重试" });
      }
    },
  );
  }
}

function sendLookupFailure(reply: { code(statusCode: number): { send(payload: unknown): unknown } }, reason: unknown): unknown {
  if (reason instanceof DashboardNativeCandidateExpiredError) {
    return reply.code(410).send({ code: "candidate_expired", message: "Dashboard 候选版本已过期，请重新生成" });
  }
  if (reason instanceof DashboardNativeCandidateNotFoundError || reason instanceof DashboardNativeCandidateAuthorityError) {
    return reply.code(404).send({ message: "Dashboard 候选版本不存在" });
  }
  return reply.code(400).send({ message: "Dashboard 候选下载请求无效" });
}

function safeFileId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96) || "candidate";
}
