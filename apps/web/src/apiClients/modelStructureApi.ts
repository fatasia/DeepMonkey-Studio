import type {
  ModelStructurePropertiesResponse,
  ModelStructureResponse,
} from "@bim-studio/contracts";

/** 装配结构树 API 客户端（transport 注入，raw fetch 只在 api.ts）。 */

type ModelStructureRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

export function createModelStructureApi(request: ModelStructureRequest) {
  return {
    /** 读取转换 sidecar 的轻量装配树；409/422 会以错误抛出，由面板转成状态语义。 */
    getModelStructure: (projectId: string, modelId: string, signal?: AbortSignal) =>
      request<ModelStructureResponse>(
        `/api/projects/${projectId}/models/${modelId}/structure`,
        signal ? { signal } : undefined,
      ),
    /** 按节点/网格 id 白名单批量查询属性（服务端上限 16 个）。
     *  id 里含有 ":" 与 "/"（如 jt-instance:5:lod-0:path-0/2），它们在 query 中是合法裸字符；
     *  一旦 encodeURIComponent 成 %2F 会撞上 ServerClient 的同源路径守卫，因此这里手工拼 query。 */
    getModelStructureProperties: (
      projectId: string,
      modelId: string,
      elementIds: readonly string[],
      signal?: AbortSignal,
    ) => {
      const unsafe = elementIds.find((id) => !/^[A-Za-z0-9:._/-]+$/.test(id));
      if (unsafe) return Promise.reject(new Error(`节点编号含有不被支持的字符：${unsafe}`));
      const query = elementIds.length ? `?ids=${elementIds.join(",")}` : "";
      return request<ModelStructurePropertiesResponse>(
        `/api/projects/${projectId}/models/${modelId}/structure/properties${query}`,
        signal ? { signal } : undefined,
      );
    },
  };
}
