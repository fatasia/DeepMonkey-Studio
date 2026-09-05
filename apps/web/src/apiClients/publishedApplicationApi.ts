import { assertApplicationDocument, type ProjectRecord, type PublishedApplicationRecord, type SystemBrandingSettings } from "@bim-studio/contracts";
import { runtimeHost } from "../adapters/runtimeHost";

export interface PublishedApplicationBundle {
  publication: PublishedApplicationRecord;
  project: ProjectRecord;
}

/** Public reads never attach the author's token or reset their login on a 404. */
export function createPublishedApplicationApi(baseUrl: string, fetcher: typeof fetch = fetch) {
  async function read(path: string, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetcher(new URL(path, baseUrl), { credentials: "omit", cache: "no-store", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) {
      if (response.status === 404) throw new Error("应用尚未发布、已撤回，或发布资源不存在。请联系发布者确认链接。");
      throw new Error(`发布服务暂时不可用（HTTP ${response.status}），请重试。`);
    }
    return response;
  }
  return {
    async browse(applicationId: string, signal?: AbortSignal): Promise<PublishedApplicationBundle> {
      const result = await (await read(`/api/public/applications/${encodeURIComponent(applicationId)}/browse`, signal)).json() as PublishedApplicationBundle;
      assertApplicationDocument(result.publication?.document);
      if (result.publication.applicationId !== applicationId || result.publication.document.metadata.id !== applicationId
        || result.publication.projectId !== result.project?.id || result.publication.document.metadata.projectId !== result.project.id
        || !Array.isArray(result.project.models)) throw new Error("发布资源与应用不匹配，请联系发布者重新发布。");
      return result;
    },
    async dependency(applicationId: string, publicationId: string, dependencyId: string): Promise<string> {
      return (await read(`/api/public/applications/${encodeURIComponent(applicationId)}/revisions/${encodeURIComponent(publicationId)}/dependencies/${encodeURIComponent(dependencyId)}`)).text();
    },
    async branding(signal?: AbortSignal): Promise<SystemBrandingSettings> {
      return (await read("/api/public/branding", signal)).json();
    },
  };
}

export const publishedApplicationApi = createPublishedApplicationApi(runtimeHost.getServerProfile().baseUrl);
