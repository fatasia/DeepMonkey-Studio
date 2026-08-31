/**
 * 查看器资产读取边界。这里只处理模型、纹理和元数据文件，不承载业务 API 请求。
 * 集中封装后，渲染与交互模块无需直接依赖浏览器网络能力。
 */
const DEFAULT_ASSET_TIMEOUT_MS = 5 * 60_000;

export interface ViewerAssetRequestOptions {
  /** 大模型允许调用方放宽超时，但禁止回到无限等待。 */
  timeoutMs?: number;
}

async function requestAsset(url: string, assetName: string, options: ViewerAssetRequestOptions = {}): Promise<Response> {
  const timeoutMs = positiveTimeout(options.timeoutMs);
  try {
    const response = await fetch(url, {
      credentials: "same-origin",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`${assetName} 下载失败：${response.status}`);
    return response;
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(`${assetName} 下载超时，请检查网络后重试`, { cause: error });
    }
    throw error;
  }
}

export async function loadViewerAssetBuffer(url: string, assetName: string, options?: ViewerAssetRequestOptions): Promise<ArrayBuffer> {
  return (await requestAsset(url, assetName, options)).arrayBuffer();
}

export async function loadViewerAssetText(url: string, assetName: string, options?: ViewerAssetRequestOptions): Promise<string> {
  return (await requestAsset(url, assetName, options)).text();
}

export async function loadViewerAssetJson<T>(url: string, assetName: string, options?: ViewerAssetRequestOptions): Promise<T> {
  return (await requestAsset(url, assetName, options)).json() as Promise<T>;
}

function positiveTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_ASSET_TIMEOUT_MS;
  return Math.floor(value);
}
