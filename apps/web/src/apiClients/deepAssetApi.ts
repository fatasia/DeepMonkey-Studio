import type { DeepAssetPackage } from "@bim-studio/deep-engine";

type ApiRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

/** 深度资产包重导入文档;package 字段与 deep-engine 的 DeepAssetPackage 对齐。 */
export interface DeepAssetPackageDocument {
  readonly package: DeepAssetPackage;
}

/** 资产包读取。原始 HTTP 传输由注入的 request(自 api.ts)承担,本文件只做业务封装,满足架构门"传输收口在 api.ts/apiClients"。 */
export function createDeepAssetApi(request: ApiRequest) {
  return {
    loadDeepAssetPackage: async (url: string, signal?: AbortSignal): Promise<DeepAssetPackageDocument> => {
      try {
        return await request<DeepAssetPackageDocument>(url, { cache: "no-store", ...(signal ? { signal } : {}) });
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (typeof status === "number") throw new Error(`资产包读取失败（HTTP ${status}），请刷新资源状态后重试`, { cause: error });
        throw error;
      }
    },
  };
}
