import type { ScenePublicationDependencies, ScenePublicationCompatibilityReport, SceneSnapshot } from "@bim-studio/contracts";

export type SceneNativeCandidateResult =
  | { status: "blocked"; report: ScenePublicationCompatibilityReport }
  | { status: "ready"; candidateId: string; expiresAt: string; report: ScenePublicationCompatibilityReport };

export function createScenePublicationDependencyApi(
  request: <T>(url: string, init?: RequestInit) => Promise<T>,
  open: (url: string, init?: RequestInit) => Promise<Response>,
) {
  return {
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
