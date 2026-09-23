/** Dashboard 离线运行包对话框的纯状态机与错误映射;视图只消费事件与渲染。 */
import type { ApplicationDocument } from "@bim-studio/contracts";

export type DashboardCandidateDownloadFormat = "exe" | "zip" | "dmda" | "web" | "apk";
export type DashboardCandidateErrorCode = "candidate_stale" | "candidate_timeout" | "candidate_concurrent"
  | "candidate_invalid" | "candidate_expired";
export type DashboardCandidateFailureCode = DashboardCandidateErrorCode | "candidate_rejected";

export class DashboardCandidateError extends Error {
  override readonly name = "DashboardCandidateError";
  constructor(readonly code: DashboardCandidateFailureCode, message: string, readonly status: number) {
    super(message);
  }
}

const CANDIDATE_CODES = new Set<string>(["candidate_stale", "candidate_timeout", "candidate_concurrent", "candidate_invalid", "candidate_expired"]);

/** 服务端的 409/410 携带机器码;其余失败(401/403/404/5xx/断网)一律归 candidate_rejected。 */
export function mapDashboardCandidateError(reason: unknown): DashboardCandidateError {
  if (reason instanceof DashboardCandidateError) return reason;
  const status = typeof (reason as { status?: unknown })?.status === "number" ? (reason as { status: number }).status : 0;
  const body = (reason as { body?: unknown })?.body;
  const code = typeof body === "object" && body !== null && typeof (body as { code?: unknown }).code === "string"
    ? (body as { code: string }).code : undefined;
  const message = reason instanceof Error && reason.message.trim() ? reason.message : "Dashboard 离线包请求失败";
  return new DashboardCandidateError(isDashboardCandidateCode(code) ? code : "candidate_rejected", message, status);
}

function isDashboardCandidateCode(code: string | undefined): code is DashboardCandidateErrorCode {
  return code !== undefined && CANDIDATE_CODES.has(code);
}

export interface DashboardCandidateObjectReport {
  readonly nodeId: string;
  readonly status: "supported" | "degraded" | "blocked";
  readonly deferredFields: readonly string[];
  /** Optional server/compiler diagnostics; absent on legacy candidate responses. */
  readonly reasons?: readonly string[];
}

export interface DashboardCandidatePrepared {
  readonly candidateId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly applicationRevision: number;
  readonly entryPageId: string;
  readonly freezeManifestSha256: string;
  readonly targetArtifactHash: string;
  readonly objects: readonly DashboardCandidateObjectReport[];
}

export interface DashboardPublicationPointer {
  readonly id: string;
  readonly projectId: string;
  readonly applicationId: string;
  readonly applicationRevision: number;
  readonly publishedAt: string;
  /** Public application responses include the immutable published document, never the editor draft. */
  readonly document?: Pick<ApplicationDocument, "pages" | "publicationProfiles">;
}

export function dashboardCandidateAuthority(pointer: DashboardPublicationPointer) {
  const document = pointer.document;
  const entryPageId = document?.publicationProfiles[0]?.entryPageId ?? document?.pages[0]?.id;
  if (!entryPageId || !document?.pages.some(page => page.id === entryPageId)) return undefined;
  return { publicationId: pointer.id, applicationRevision: pointer.applicationRevision, entryPageId };
}

export type DashboardOfflinePackageEvent =
  | { readonly type: "publication"; readonly pointer: DashboardPublicationPointer | undefined }
  | { readonly type: "prepare" }
  | { readonly type: "prepared"; readonly candidate: DashboardCandidatePrepared }
  | { readonly type: "failed"; readonly error: DashboardCandidateError }
  | { readonly type: "cancelled" };

export type DashboardOfflinePackageState =
  | { readonly phase: "loading" }
  | { readonly phase: "unpublished" }
  | { readonly phase: "idle"; readonly pointer: DashboardPublicationPointer }
  | { readonly phase: "preparing"; readonly pointer: DashboardPublicationPointer }
  | { readonly phase: "ready"; readonly pointer: DashboardPublicationPointer; readonly candidate: DashboardCandidatePrepared }
  | { readonly phase: "failed"; readonly pointer: DashboardPublicationPointer; readonly error: DashboardCandidateError };

export function initialDashboardOfflinePackageState(): DashboardOfflinePackageState {
  return { phase: "loading" };
}

/** 迟到响应由调用方在 dispatch 前丢弃(ticket 比对),这里保持纯函数。 */
export function reduceDashboardOfflinePackage(state: DashboardOfflinePackageState, event: DashboardOfflinePackageEvent): DashboardOfflinePackageState {
  switch (event.type) {
    case "publication":
      return state.phase === "loading"
        ? event.pointer ? { phase: "idle", pointer: event.pointer } : { phase: "unpublished" }
        : state;
    case "prepare":
      return state.phase === "idle" || state.phase === "ready" || state.phase === "failed"
        ? { phase: "preparing", pointer: state.pointer }
        : state;
    case "prepared":
      return state.phase === "preparing" ? { phase: "ready", pointer: state.pointer, candidate: event.candidate } : state;
    case "failed":
      return state.phase === "preparing" || state.phase === "ready"
        ? { phase: "failed", pointer: state.pointer, error: event.error }
        : state;
    case "cancelled":
      return state.phase === "preparing" ? { phase: "idle", pointer: state.pointer } : state;
  }
}

/** 下载失败语义:过期/失效必须引导重新准备,其余失败给出服务端原话。 */
export function downloadFailureGuidance(error: DashboardCandidateError): string {
  if (error.code === "candidate_expired") return "离线包候选已过期，请重新准备后再下载";
  if (error.code === "candidate_invalid") return "离线包候选已失效，请重新准备";
  return error.message || "下载失败，请稍后重试";
}

/** 服务端 attachment 头的文件名;解析失败回退到 candidateId 后缀。 */
export function dashboardCandidateFilename(disposition: string | null, candidateId: string, format: DashboardCandidateDownloadFormat): string {
  const match = /filename="([^"]+)"/.exec(disposition ?? "");
  const name = match?.[1]?.trim();
  return name && !/[\\/\u0000-\u001f]/.test(name) ? name : `dashboard-candidate-${candidateId}.${format}`;
}

export function summarizeCandidateObjects(objects: readonly DashboardCandidateObjectReport[]): {
  readonly supported: number; readonly degraded: number; readonly blocked: number; readonly total: number;
} {
  return { supported: objects.filter(object => object.status === "supported").length,
    degraded: objects.filter(object => object.status === "degraded").length,
    blocked: objects.filter(object => object.status === "blocked").length, total: objects.length };
}
