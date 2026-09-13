import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ANIMATION } from "../appDefaults";
import { DashboardComponentLibrary, resolveDashboardLibraryItem } from "./DashboardComponentLibrary";
import { ModelAssetWorkflowActions } from "./ModelAssetWorkflowActions";
import { SceneTimelinePanel } from "./SceneTimelinePanel";

describe("workspace UI regressions", () => {
  it("keeps 2D resource preview artwork free of text overlays", () => {
    const html = renderToStaticMarkup(<DashboardComponentLibrary
      locale="zh-CN"
      projectId="project-1"
      sceneAvailable
      topologies={[{ id: "topology-1", name: "总装线拓扑" }]}
      searchInputRef={{ current: null }}
      onOpenTemplates={vi.fn()}
      onAddSceneViewport={vi.fn()}
      onAddWidget={vi.fn()}
    />);
    expect(html).not.toContain("dashboard-library-preview-mark");
    expect(html).toContain("基础控件");
    expect(html).toContain("资源库");
    expect(html).toContain("明细表");
    expect(html).toContain("滚动表格");
    expect(html).toContain("输入框");
    expect(html).toContain("下拉框");
    for (const id of ["basic:image", "basic:video", "basic:monitor", "basic:unity", "basic:topology", "basic:table", "basic:scroll-table"]) {
      expect(resolveDashboardLibraryItem("zh-CN", id, [{ id: "topology-1", name: "总装线拓扑" }])).toBeDefined();
    }
    expect(resolveDashboardLibraryItem("zh-CN", "topology:topology-1", [{ id: "topology-1", name: "总装线拓扑" }])?.widget?.topologyId).toBe("topology-1");
  });

  it("exposes a resizable timeline with a clear track creation entry", () => {
    const html = renderToStaticMarkup(<SceneTimelinePanel
      locale="zh-CN"
      animation={DEFAULT_ANIMATION}
      currentTime={0}
      playing={false}
      selectedObjectName="设备 001"
      selectedObjectLocked={false}
      modelNames={new Map()}
      onClose={vi.fn()}
      onPlayPause={vi.fn()}
      onSeek={vi.fn()}
      onChange={vi.fn()}
      onRecordCamera={vi.fn()}
      onRecordObject={vi.fn()}
      onDeleteFrame={vi.fn()}
      workspace="timeline"
      onWorkspaceChange={vi.fn()}
      cameraWorkspace={<div>camera workspace</div>}
    />);
    expect(html).toContain("timeline-panel-resizable");
    expect(html).toContain("新增轨道");
    expect(html).toContain("场景导演台");
    expect(html).toContain("镜头");
    expect(html).toContain("漫游");
    expect(html).toContain("自动关键帧");
    expect(html).not.toContain("timeline-range");
  });

  it("names the optimized-model continuation action explicitly", () => {
    const html = renderToStaticMarkup(<ModelAssetWorkflowActions locale="zh-CN" savedModelId="model-1" busy={false} onReturn={vi.fn()} />);
    expect(html).toContain("插入并返回场景");
    expect(html).toContain("原场景续接");
  });
});
