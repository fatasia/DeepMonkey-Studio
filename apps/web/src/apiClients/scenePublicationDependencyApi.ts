import type { ScenePublicationDependencies, ScenePublicationCompatibilityReport, SceneSnapshot } from "@bim-studio/contracts";
import type { ClientPackageBranding } from "../components/clientPackageBranding";

export type SceneNativeCandidateResult =
  | { status: "blocked"; report: ScenePublicationCompatibilityReport }
  | { status: "ready"; candidateId: string; expiresAt: string; report: ScenePublicationCompatibilityReport };

export function createScenePublicationDependencyApi(
  request: <T>(url: string, init?: RequestInit) => Promise<T>,
  open: (url: string, init?: RequestInit) => Promise<Response>,
) {
  return {
    downloadThreeSceneExecutable: async (projectId: string, sceneId: string, version: number, archive: Blob, signal: AbortSignal) => {
      if (!Number.isSafeInteger(version) || version < 1) throw new Error("发布版本无效");
      const body = new FormData(); body.append("archive", archive, "scene.bimscene.zip");
      const response = await open(`/api/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/publications/${version}/three-webview-executable`, {
        method: "POST", body, signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]),
      });
      if (!response.ok) { const value = await response.json().catch(() => undefined); throw new Error(value?.message ?? `Three WebView 客户端构建失败 (${response.status})`); }
      return response.blob();
    },
    downloadSceneExecutable: async (projectId: string, sceneId: string, version: number, signal: AbortSignal, branding?: ClientPackageBranding) => {
      if (!Number.isSafeInteger(version) || version < 1) throw new Error("发布版本无效");
      const response = await open(`/api/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/publications/${version}/native-executable`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(branding ? { branding } : {}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
      });
      if (!response.ok) { const body = await response.json().catch(() => undefined); throw new Error(body?.message ?? `客户端下载失败 (${response.status})`); }
      const length = Number(response.headers.get("content-length"));
      if (!Number.isSafeInteger(length) || length < 48 || length > 776 * 1024 ** 2) throw new Error("客户端文件大小无效");
      const reader = response.body?.getReader(); if (!reader) throw new Error("客户端下载响应为空");
      const chunks: Uint8Array<ArrayBuffer>[] = []; let bytes = 0;
      try {
        while (true) { signal.throwIfAborted(); const item = await reader.read(); if (item.done) break;
          bytes += item.value.byteLength; if (bytes > length) throw new Error("客户端文件超出预算"); chunks.push(Uint8Array.from(item.value)); }
        if (bytes !== length) throw new Error("客户端文件不完整"); signal.throwIfAborted();
        return new Blob(chunks, { type: "application/vnd.microsoft.portable-executable" });
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    },
    createNativeSceneCandidate: (projectId: string, sceneId: string, expectedSnapshot: SceneSnapshot) =>
      request<SceneNativeCandidateResult>(`/api/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/native-candidates`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedSnapshot }),
      }),
    getScenePublicationDependencies: (projectId: string, sceneId: string, version: number, signal: AbortSignal) =>
      request<ScenePublicationDependencies>(`/api/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/publications/${version}/dependencies`, { signal }),
    loadScenePublicationResource: async (url: string, bytes: number, signal: AbortSignal): Promise<ArrayBuffer> => {
      if (!/^\/api\/projects\/[^/]+\/scenes\/[^/]+\/publications\/[1-9]\d*\/dependencies\/resources\/[a-f0-9]{64}$/.test(url)) throw new Error("冻结资源地址无效");
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 256 * 1024 ** 2) throw new Error("冻结资源大小无效");
      const response = await open(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("冻结资源响应为空");
      const output = new Uint8Array(bytes); let offset = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const item = await reader.read();
          if (item.done) break;
          if (offset + item.value.byteLength > bytes) throw new Error("冻结资源大小与记录不符");
          output.set(item.value, offset); offset += item.value.byteLength;
        }
        if (offset !== bytes) throw new Error("冻结资源不完整");
        signal.throwIfAborted();
        return output.buffer;
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    },
  };
}
