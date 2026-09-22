import type { FastifyInstance } from "fastify";
import path from "node:path";
import type { PublishedApplicationRecord } from "@bim-studio/contracts";
import { createDashboardWebStaticPackage } from "./dashboardWebStaticPackage.js";
import { createDashboardPortableZip } from "./dashboardPortableZip.js";
import { createDashboardStandaloneExecutable } from "./dashboardStandaloneExecutable.js";
import { parseClientPackageBranding, type ClientPackageBranding } from "./clientPackageBranding.js";
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
  assertDashboardCandidatePublicationGate,
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
  /** 部署固定播放器路径；HTTP 不能覆盖。未配置时不注册 ZIP/EXE 路由。 */
  readonly portable?: {
    readonly nativeExecutable: string;
    readonly expectedSha256?: string;
    readonly createZip?: typeof createDashboardPortableZip;
    readonly createExecutable?: typeof createDashboardStandaloneExecutable;
  };
  /** Web 静态包下载的部署侧供给；未配置时不注册 web-package 路由。 */
  readonly webStatic?: DashboardWebStaticDownloadDependencies;
}

export interface DashboardWebStaticDownloadDependencies {
  /** 从应用存储读取候选对应的原始发布记录；缺失时下载按候选失效处理。 */
  readonly readPublication: (input: {
    readonly record: DashboardNativeCandidateRecord;
    readonly signal?: AbortSignal;
  }) => Promise<PublishedApplicationRecord | undefined>;
  /** 对象目录读取 port；实现必须把读取限制在部署的对象根内。 */
  readonly readResourceObject: (objectKey: string, signal?: AbortSignal) => Promise<Uint8Array>;
  readonly licensedFonts: readonly { readonly path: string; readonly licensePath: string }[];
  /** 预构建 dashboard-static 产物目录的绝对路径。 */
  readonly webStaticRoot: string;
}

/**
 * Serves verified C5 candidates as DMDA or deployment-enabled ZIP/single EXE.
 * This module deliberately does not register itself in the global route index,
 * so composition owns the concrete store and identity integrations.
 */
export async function registerDashboardOfflineArchiveDownloadRoutes(
  app: FastifyInstance,
  dependencies: DashboardOfflineArchiveDownloadDependencies,
): Promise<void> {
  const portable = dependencies.portable;
  const executable = portable?.nativeExecutable;
  const expectedSha256 = portable?.expectedSha256;
  if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("Invalid expected Native executable SHA-256");
  if (portable && (!executable || !path.isAbsolute(executable) || path.extname(executable).toLowerCase() !== ".exe")) {
    throw new Error("Dashboard portable download requires an absolute .exe path");
  }
  const createZip = portable?.createZip ?? createDashboardPortableZip;
  const createExecutable = portable?.createExecutable ?? createDashboardStandaloneExecutable;
  const webStatic = dependencies.webStatic;
  if (webStatic && (!path.isAbsolute(webStatic.webStaticRoot) || typeof webStatic.readPublication !== "function"
    || typeof webStatic.readResourceObject !== "function")) {
    throw new Error("Dashboard web package download requires an absolute static root and object reader");
  }
  const formats = ["dmda", ...(portable ? ["zip", "exe"] : []), ...(webStatic ? ["web"] : [])] as const;
  for (const format of formats) {
  const endpoint = format === "exe" ? "standalone-executable" : format === "zip" ? "portable-zip" : format === "web" ? "web-package" : "offline-archive";
  app.route<{ Params: RouteParams; Body: { branding?: unknown } }>({
    method: format === "exe" || format === "zip" ? ["GET", "POST"] : "GET",
    url: `/api/projects/:projectId/applications/:applicationId/dashboard-candidates/:candidateId/${endpoint}`,
    bodyLimit: 3 * 1024 ** 2,
    handler: async (request, reply) => {
      if (!request.systemUser?.enabled) return reply.code(401).send({ message: "请先登录" });
      if (request.systemUser.role === "viewer") return reply.code(403).send({ message: "浏览者不能下载 Dashboard 候选离线包" });
      if (request.systemUser.role !== "admin" && !request.systemUser.projectIds.includes(request.params.projectId)) {
        return reply.code(403).send({ message: "没有该项目的访问权限" });
      }
      if (format !== "dmda" && Object.keys(request.query as object).length !== 0) {
        return reply.code(400).send({ message: "Dashboard 下载不接受查询参数" });
      }
      let branding: ClientPackageBranding | undefined;
      if (request.method === "POST") {
        try {
          if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)
            || Object.keys(request.body).some(key => key !== "branding")) throw new Error("客户端打包请求无效");
          branding = await parseClientPackageBranding(request.body.branding, request.signal);
        } catch (error) {
          return reply.code(400).send({ code: "invalid_client_branding", message: error instanceof Error ? error.message : "客户端品牌设置无效" });
        }
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
      // P0-04 下载复核:候选登记后能力报告被篡改或不再自洽时,旧记录同样不可下载。
      try {
        assertDashboardCandidatePublicationGate(record.candidate);
      } catch {
        return reply.code(409).send({ code: "candidate_invalid", message: "Dashboard 候选离线包已失效，请刷新后重试" });
      }

      try {
        const freezeManifest = await dependencies.readFreezeManifest({
          record,
          signal: request.signal,
        });
        request.signal.throwIfAborted();
        if (!freezeManifest) return reply.code(409).send({ code: "candidate_invalid", message: "Dashboard 候选离线包已失效，请刷新后重试" });
        let bytes: Uint8Array;
        if (format === "web") {
          // Web 静态包不经过 DMDA 归档：直接从发布记录 + 冻结清单 + 对象 port 编译。
          const publication = await webStatic!.readPublication({ record, signal: request.signal });
          request.signal.throwIfAborted();
          if (!publication) return reply.code(409).send({ code: "candidate_invalid", message: "Dashboard 候选离线包已失效，请刷新后重试" });
          bytes = await createDashboardWebStaticPackage({ publication, freezeManifest,
            readResourceObject: objectKey => webStatic!.readResourceObject(objectKey, request.signal),
            licensedFonts: webStatic!.licensedFonts, webStaticRoot: webStatic!.webStaticRoot, signal: request.signal });
        } else {
          const archive = (dependencies.createArchive ?? createDashboardOfflineArchive)({
            freezeManifest,
            capability: record.candidate.capability,
            artifact: record.candidate.artifact.artifact,
          });
          const archiveBytes = (dependencies.serializeArchive ?? serializeDashboardOfflineArchive)(archive);
          request.signal.throwIfAborted();
          const packagingOptions = { signal: request.signal, ...(expectedSha256 === undefined ? {} : { expectedSha256 }), ...(branding ? { branding } : {}) };
          bytes = format === "zip"
            ? await createZip(archiveBytes, executable!, packagingOptions)
            : format === "exe" ? await createExecutable(archiveBytes, executable!, packagingOptions) : archiveBytes;
        }
        request.signal.throwIfAborted();
        // 清单读取及 ZIP 压缩均可能等待；发送前重查 TTL 和候选撤销状态。
        try {
          dependencies.registry.read({ candidateId: request.params.candidateId,
            projectId: request.params.projectId, applicationId: request.params.applicationId });
        } catch (reason) { return sendLookupFailure(reply, reason); }
        return reply
          .header("cache-control", "private, no-store")
          .header("content-disposition", `attachment; filename="dashboard-candidate-${safeFileId(record.summary.candidateId)}.${format === "web" ? "web.zip" : format}"${branding?.applicationName ? `; filename*=UTF-8''${encodeURIComponent(branding.applicationName.replace(/[<>:"/\\|?*]/g, "_")).replace(/'/g, "%27")}.${format}` : ""}`)
          .header("content-length", String(bytes.byteLength))
          .header("x-content-type-options", "nosniff")
          .type(format === "exe" ? "application/vnd.microsoft.portable-executable"
            : format === "zip" || format === "web" ? "application/zip" : "application/octet-stream")
          .send(Buffer.from(bytes));
      } catch {
        return reply.code(409).send({ code: "candidate_invalid", message: "Dashboard 候选离线包已失效，请刷新后重试" });
      }
    },
  });
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
