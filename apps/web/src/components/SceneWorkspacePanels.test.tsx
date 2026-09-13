import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ENVIRONMENT,
  DEFAULT_LIGHTING,
  DEFAULT_POST_PROCESSING,
} from "../appDefaults";
import { DEFAULT_SCENE_COORDINATES } from "../viewer/sceneCoordinates";
import { FlatSpaceList } from "./FlatSpaceList";
import { SceneEnvironmentPanel } from "./SceneEnvironmentPanel";
import { SceneOutlinerPanel } from "./SceneOutlinerPanel";

describe("scene workspace panels", () => {
  it("renders spaces as flat scene objects without a nested directory", () => {
    const html = renderToStaticMarkup(
      <FlatSpaceList
        locale="zh-CN"
        spaces={[
          {
            id: "space-1",
            modelId: "model-1",
            modelName: "厂房 A",
            name: "控制室",
            number: "101",
            level: "一层",
            kind: "room",
            areaSquareMetres: 36.5,
          },
          {
            id: "space-2",
            modelId: "model-1",
            modelName: "厂房 A",
            name: "设备间",
            level: "一层",
            kind: "space",
          },
        ]}
        isVisible={() => true}
        onFocus={vi.fn()}
        onVisibilityChange={vi.fn()}
      />,
    );

    expect(html.match(/scene-object-row/g)).toHaveLength(2);
    expect(html).toContain("101 控制室");
    expect(html).toContain("一层 · 厂房 A · 36.50 m²");
    expect(html).not.toContain("space-group");
  });

  it("keeps environment capabilities in one coherent task panel", () => {
    const html = renderToStaticMarkup(
      <SceneEnvironmentPanel
        locale="zh-CN"
        rendererBackend="webgpu"
        coordinates={DEFAULT_SCENE_COORDINATES}
        weather="sunny"
        environment={DEFAULT_ENVIRONMENT}
        lighting={DEFAULT_LIGHTING}
        postProcessing={DEFAULT_POST_PROCESSING}
        selectedLightId="sun-default"
        onCoordinatesChange={vi.fn()}
        onWeatherChange={vi.fn()}
        onEnvironmentChange={vi.fn()}
        onLightingChange={vi.fn()}
        onPostProcessingChange={vi.fn()}
        onChooseEnvironmentMap={vi.fn()}
        onSelectLight={vi.fn()}
        onAddLight={vi.fn()}
        onUpdateLight={vi.fn()}
        onRemoveLight={vi.fn()}
      />,
    );

    expect(html).toContain("场景环境");
    expect(html).toContain("坐标与单位");
    expect(html).toContain("光源");
    expect(html).toContain("后处理");
    expect(html).toContain("调色");
    expect(html).not.toContain("实时后处理当前使用 WebGL 管线");
  });

  it("keeps object browsing and grouping in one scene-object manager", () => {
    const html = renderToStaticMarkup(
      <SceneOutlinerPanel
        locale="zh-CN"
        uploading={false}
        importOpen={false}
        rvtConversionMode="native-glb"
        revitVersion="auto"
        revitRuntime={{ installations: [], defaultVersion: "auto" }}
        query=""
        level=""
        category=""
        facets={{ levels: [], categories: [] }}
        results={[]}
        bindingComponents={[]}
        searchActive={false}
        isolationActive={false}
        objectContent={<span>模型、灯光、空间同层内容</span>}
        onImportModel={vi.fn()}
        onImportClose={vi.fn()}
        onWorkflowClose={vi.fn()}
        onRvtConversionModeChange={vi.fn()}
        onRevitVersionChange={vi.fn()}
        onInsertProjectModel={vi.fn()}
        onInsertPrefab={vi.fn()}
        onCreateDeviceLayout={vi.fn()}
        onConfirmSmartBindings={vi.fn()}
        onQueryChange={vi.fn()}
        onLevelChange={vi.fn()}
        onCategoryChange={vi.fn()}
        onResultFocus={vi.fn()}
        onResultsIsolate={vi.fn()}
        onIsolationRestore={vi.fn()}
      />,
    );

    expect(html).toContain("模型、灯光、空间同层内容");
    expect(html).not.toContain("编组与选择集");
    expect(html).not.toContain("批量组织内容");
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain("场景对象列表");
    expect(html).not.toContain("space-tree");
  });
});
