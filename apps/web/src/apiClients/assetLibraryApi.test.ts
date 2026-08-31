import { describe, expect, it } from "vitest";
import { createAssetLibraryApi } from "./assetLibraryApi";

describe("assetLibraryApi", () => {
  it("encodes catalog filters and imports through the project boundary", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
      calls.push([url, init]);
      return { items: [] } as T;
    };
    const client = createAssetLibraryApi(request);

    await client.listAssetLibrary({ search: "机械臂 & AGV", dimension: "material", category: "工业场景", featured: false, page: 3, pageSize: 24 });
    await client.importAssetLibraryItem("project/1", "industrial-10");

    expect(calls[0]?.[0]).toBe("/api/asset-library?dimension=material&q=%E6%9C%BA%E6%A2%B0%E8%87%82+%26+AGV&category=%E5%B7%A5%E4%B8%9A%E5%9C%BA%E6%99%AF&featured=false&page=3&pageSize=24");
    expect(calls[1]).toEqual(["/api/projects/project%2F1/asset-library/industrial-10/import", { method: "POST" }]);
  });
});
