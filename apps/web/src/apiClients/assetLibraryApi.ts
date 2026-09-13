import type { AssetLibraryDimension, AssetLibraryImportResult, AssetLibraryItem, AssetLibraryPage, ProjectAssetMapRecord } from "@bim-studio/contracts";

type ApiRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

export interface AssetLibraryListOptions {
  search?: string;
  dimension?: AssetLibraryDimension | "all";
  category?: string;
  featured?: boolean;
  page?: number;
  pageSize?: number;
}

/** 素材目录与项目导入保持独立，避免把大目录状态塞进场景管理控制器。 */
export function createAssetLibraryApi(request: ApiRequest) {
  return {
    getAssetLibraryItem: (itemId: string, signal?: AbortSignal) => request<AssetLibraryItem>(`/api/asset-library/items/${encodeURIComponent(itemId)}`, signal ? { signal } : {}),
    getAssetLibraryMaps: (itemId: string, signal?: AbortSignal) => request<ProjectAssetMapRecord[]>(`/api/asset-library/items/${encodeURIComponent(itemId)}/maps`, signal ? { signal } : {}),
    listAssetLibrary: (options: AssetLibraryListOptions = {}) => {
      const query = new URLSearchParams({ dimension: options.dimension ?? "all" });
      if (options.search) query.set("q", options.search);
      if (options.category && options.category !== "all") query.set("category", options.category);
      if (options.featured !== undefined) query.set("featured", String(options.featured));
      if (options.page) query.set("page", String(options.page));
      if (options.pageSize) query.set("pageSize", String(options.pageSize));
      return request<AssetLibraryPage>(`/api/asset-library?${query}`);
    },
    importAssetLibraryItem: (projectId: string, itemId: string) =>
      request<AssetLibraryImportResult>(
        `/api/projects/${encodeURIComponent(projectId)}/asset-library/${encodeURIComponent(itemId)}/import`,
        { method: "POST" },
      ),
  };
}
