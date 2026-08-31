import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AssetLibraryPage } from "@bim-studio/contracts";
import { AssetLibraryBrowser } from "./AssetLibraryBrowser";

const catalogPage: AssetLibraryPage = {
  items: [{
    id: "industrial-10", name: "六轴机械臂", dimension: "3d", category: "工业场景", subcategory: "机器人", style: "写实",
    format: "glb", size: 1_024_000, triangleCount: 12_400, meshCount: 8, materialCount: 4, textureCount: 2,
    animated: true, featured: true, qualityTier: "light", thumbnailUrl: "/thumb.png", previewUrl: "/preview.glb", tags: ["机器人"],
    version: "1.0.0", license: "内部许可", publicationStatus: "published", contentHash: "hash",
  }],
  page: 1, pageSize: 24, total: 300, totalPages: 13,
  categories: [{ id: "工业场景", name: "工业场景", count: 1_551 }],
  dimensions: [{ id: "3d", name: "3d", count: 1_551 }],
};

vi.mock("./useAssetLibraryCatalog", () => ({
  useAssetLibraryCatalog: () => ({
    result: catalogPage, search: "", dimension: "all", category: "all", featuredOnly: true, loading: false, catalogError: undefined, importError: undefined, importingId: undefined,
    setPage: vi.fn(), updateSearch: vi.fn(), updateDimension: vi.fn(), updateCategory: vi.fn(), updateFeaturedOnly: vi.fn(), importItem: vi.fn(), clearImportError: vi.fn(), reload: vi.fn(),
  }),
}));

describe("AssetLibraryBrowser", () => {
  it("shows useful metadata and recognizes a catalog item already imported into the project", () => {
    const html = renderToStaticMarkup(
      <AssetLibraryBrowser
        locale="zh-CN"
        projectId="default"
        projectModels={[{
          id: "model-1", projectId: "default", name: "六轴机械臂", format: "glb", size: 1, status: "ready", progress: 100,
          message: "可使用", sourceUrl: "/assets/model.glb", libraryOrigin: { itemId: "industrial-10", contentHash: "hash", catalogVersion: 1 },
          createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
        }]}
        projectAssets={[]}
        onImported={async () => undefined}
      />,
    );

    expect(html).toContain("<strong>300</strong>");
    expect(html).toContain("个精选素材 · 全库 1,551 个");
    expect(html).toContain("六轴机械臂");
    expect(html).toContain("动画");
    expect(html).toContain("1.2 万面");
    expect(html).toContain("已在项目");
    expect(html).toContain("环境 HDRI");
    expect(html).toContain("PBR 材质");
    expect(html).toContain("内部许可 · v1.0.0");
  });
});
