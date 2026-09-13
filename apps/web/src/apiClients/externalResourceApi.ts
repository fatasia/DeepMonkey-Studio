const EXTERNAL_JSON_TIMEOUT_MS = 30_000;
const EXTERNAL_MODEL_TIMEOUT_MS = 10 * 60_000;

function parseExternalUrl(url: string, baseUrl: string, errorMessage: string): URL {
  const parsed = new URL(url, baseUrl);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(errorMessage);
  }
  return parsed;
}

/** 外部资源读取集中在一个边界，统一限制协议、凭据和请求时长。 */
type ExternalResourceRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createExternalResourceApi(
  getBaseUrl: () => string,
  openExternal: ExternalResourceRequest,
) {
  return {
    getExternalJson: async (url: string): Promise<unknown> => {
      const parsed = parseExternalUrl(url, getBaseUrl(), "外部资源地址必须是无凭据的 HTTP(S) URL");
      const response = await openExternal(parsed, {
        credentials: "omit",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(EXTERNAL_JSON_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`外部资源 HTTP ${response.status}`);
      return response.json();
    },
    downloadExternalModel: async (url: string): Promise<Blob> => {
      const parsed = parseExternalUrl(url, getBaseUrl(), "模型地址必须是无凭据的 HTTP(S) URL");
      const response = await openExternal(parsed, {
        credentials: "omit",
        headers: { accept: "model/gltf-binary,model/gltf+json,application/octet-stream" },
        signal: AbortSignal.timeout(EXTERNAL_MODEL_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`模型文件读取失败（HTTP ${response.status}）`);
      return response.blob();
    },
  };
}
