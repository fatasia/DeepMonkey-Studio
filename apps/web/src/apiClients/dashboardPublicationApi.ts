import type {
  DashboardCandidateDownloadFormat, DashboardCandidatePrepared, DashboardPublicationPointer,
} from "../components/dashboardOfflinePackageState.js";
import type { ClientPackageBranding } from "../components/clientPackageBranding.js";

/** 发布身份与离线候选共用认证客户端，保持取消信号贯穿准备和下载。 */
export function createDashboardPublicationApi(
  request: <T>(url: string, init?: RequestInit) => Promise<T>,
  open: (url: string, init?: RequestInit) => Promise<Response>,
) {
  const applicationPath = (projectId: string, applicationId: string) =>
    `/api/projects/${encodeURIComponent(projectId)}/applications/${encodeURIComponent(applicationId)}`;
  const endpoint = (format: DashboardCandidateDownloadFormat) =>
    format === "exe" ? "standalone-executable" : format === "zip" ? "portable-zip"
      : format === "web" ? "web-package" : format === "apk" ? "android-apk" : "offline-archive";
  return {
    readActivePublication: (applicationId: string) =>
      request<DashboardPublicationPointer>(`/api/public/applications/${encodeURIComponent(applicationId)}`),
    prepareDashboardCandidate: (
      projectId: string, applicationId: string,
      authority: { publicationId: string; applicationRevision: number; entryPageId: string },
      signal?: AbortSignal,
    ) => request<DashboardCandidatePrepared>(`${applicationPath(projectId, applicationId)}/dashboard-candidates`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(authority),
      ...(signal ? { signal } : {}),
    }),
    openDashboardCandidateDownload: (
      projectId: string, applicationId: string, candidateId: string,
      format: DashboardCandidateDownloadFormat, signal?: AbortSignal,
      branding?: ClientPackageBranding,
      signing?: DashboardCandidateAndroidSigning,
    ) => open(`${applicationPath(projectId, applicationId)}/dashboard-candidates/${encodeURIComponent(candidateId)}/${endpoint(format)}`,
      { ...(signal ? { signal } : {}), ...((format === "exe" || format === "zip") && branding && Object.keys(branding).length
        ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ branding }) }
        : format === "apk" && signing && Object.keys(signing).length
          ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signing }) } : {}) }),
  };
}

/** 请求级 Android 签名:keystore 以 base64 随请求上传;缺省时服务端用部署默认签名。 */
export interface DashboardCandidateAndroidSigning {
  readonly keystoreBase64?: string;
  readonly storePassword: string;
  readonly keyAlias: string;
  readonly keyPassword?: string;
}
