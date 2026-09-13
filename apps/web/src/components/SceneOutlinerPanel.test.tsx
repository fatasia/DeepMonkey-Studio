import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ModelRecord, ProjectAssetRecord } from "@bim-studio/contracts";
import { SceneResourceBrowser } from "./SceneOutlinerPanel";

describe("SceneResourceBrowser", () => {
  it("merges project models and assets into the 3D resource entry", () => {
    const html = renderToStaticMarkup(
      <SceneResourceBrowser
        locale="zh-CN"
        projectModels={[{ id: "model-1", name: "六轴机器人", format: "glb" } as ModelRecord]}
        projectAssets={[{ id: "asset-1", name: "设备铭牌", fileName: "plate.png", kind: "image" } as ProjectAssetRecord]}
        onImportModel={vi.fn()}
        onInsertProjectModel={vi.fn()}
        onInsertPrefab={vi.fn()}
      />,
    );

    expect(html).toContain("项目资源");
    expect(html).toContain("六轴机器人");
    expect(html).toContain("设备铭牌");
    expect(html).toContain("plate.png");
    expect(html).toContain(">载入<");
    expect(html).toContain("属性中应用");
    expect(html).toContain("工业预制体");
    expect(html).toContain("平台素材");
  });

  it("keeps built-in 3D resources available when a project has no uploads", () => {
    const html = renderToStaticMarkup(
      <SceneResourceBrowser
        locale="zh-CN"
        projectModels={[]}
        projectAssets={[]}
        onImportModel={vi.fn()}
        onInsertProjectModel={vi.fn()}
        onInsertPrefab={vi.fn()}
      />,
    );

    expect(html).toContain("场景资源");
    expect(html).toContain("三轴直角坐标机器人");
    expect(html).toContain("显示全部");
    expect(html).toContain("scene-prefab-thumbnail");
    expect(html).toContain('data-kind="robot-arm"');
  });
});
