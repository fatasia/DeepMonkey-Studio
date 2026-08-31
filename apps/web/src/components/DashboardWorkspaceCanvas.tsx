import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  Focus,
  Group,
  LayoutTemplate,
  Minus,
  Plus,
  Scaling,
  ScanSearch,
  Shapes,
  Ungroup,
} from "lucide-react";
import { createUpdateDashboardPageGuidesCommand } from "@bim-studio/studio-core";
import { translate as tr } from "../i18n";
import { DashboardNode } from "./DashboardCanvasNode";
import { DashboardRuler } from "./DashboardRuler";
import { dashboardBackgroundStyle } from "./dashboardCanvasStyle";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";
import { EditorEmptyState } from "./EditorEmptyState";

export function DashboardWorkspaceCanvas() {
  const {
    activeSnapLines,
    addGuide,
    allowLibraryDrop,
    application,
    artboardOffsetX,
    artboardOffsetY,
    artboardRef,
    beginCanvasPan,
    beginGuideDrag,
    beginMarqueeSelection,
    beginNodeTransform,
    changeZoom,
    componentSearchRef,
    currentView,
    draftFrames,
    draftGuides,
    dropLibraryItem,
    filters,
    fitCanvasToViewport,
    groupSelectedNodes,
    guidesVisible,
    handleCanvasScroll,
    layoutSelectedNodes,
    layoutSelectionCount,
    libraryDropActive,
    locale,
    marqueeMode,
    onCommand,
    onEnterScene,
    onFilterChange,
    onNodeInteraction,
    onObjectInteraction,
    onSelectionChange,
    onVariableChange,
    openNodeContextMenu,
    overflowNodeIds,
    page,
    panning,
    project,
    rendererBackend,
    runtimeMetrics,
    scrollRef,
    selectNode,
    selectOverflowNodes,
    selectedNodeIds,
    selectionRect,
    setGuidesVisible,
    setLeftPanelTab,
    setLibraryDropActive,
    setMarqueeMode,
    setSelectedNodeIds,
    setSnapEnabled,
    setTemplateLibraryOpen,
    snapEnabled,
    stageHeight,
    stageWidth,
    surfaceSize,
    ungroupSelectedNodes,
    variables,
    viewportScroll,
    zoom,
    zoomCanvas,
  } = useDashboardWorkspace();
  return (
    <section className="dashboard-design-surface">
      <div className="dashboard-canvas-toolbar">
        <span>
          {page.width} × {page.height}
          <small>
            {tr(locale, "空格/中键平移 · Ctrl/Cmd+滚轮缩放 · Shift 框选 · 方向键微调", "Space/middle-button pan · Ctrl/Cmd+wheel zoom · Shift box-select · Arrows nudge")}
          </small>
          {overflowNodeIds.length > 0 && (
            <button
              className="dashboard-overflow-warning"
              title={tr(locale, "选择所有超出页面边界的组件", "Select all components outside the page bounds")}
              onClick={selectOverflowNodes}
            >
              {tr(locale, `${overflowNodeIds.length} 个组件越界`, `${overflowNodeIds.length} out of bounds`)}
            </button>
          )}
        </span>
        <div className="dashboard-layout-tools" aria-label={tr(locale, "排版工具", "Layout tools")}>
          <div className="dashboard-tool-group">
            <button
              className={marqueeMode ? "active" : ""}
              title={tr(locale, "框选组件（Shift+拖动）", "Box select (Shift-drag)")}
              onClick={() => setMarqueeMode((active) => !active)}
            >
              <ScanSearch size={13} />
            </button>
            <button
              className={snapEnabled ? "active" : ""}
              title={tr(locale, "智能吸附：网格、参考线和组件边缘", "Smart snap: grid, guides and component edges")}
              onClick={() => setSnapEnabled((enabled) => !enabled)}
            >
              {tr(locale, "吸附", "Snap")}
            </button>
            <button className={guidesVisible ? "active" : ""} title={tr(locale, "显示或隐藏参考线", "Show or hide guides")} onClick={() => setGuidesVisible((visible) => !visible)}>
              {tr(locale, "参考线", "Guides")}
            </button>
          </div>
          <div className="dashboard-tool-group">
            <button
              disabled={selectedNodeIds.filter((id) => page.nodes.some((node) => node.id === id && node.locked !== true)).length < 2}
              title={tr(locale, "编组", "Group")}
              onClick={groupSelectedNodes}
            >
              <Group size={13} />
            </button>
            <button
              disabled={!page.nodes.some((node) => selectedNodeIds.includes(node.id) && node.groupId && node.locked !== true)}
              title={tr(locale, "解组", "Ungroup")}
              onClick={ungroupSelectedNodes}
            >
              <Ungroup size={13} />
            </button>
          </div>
          <div className="dashboard-tool-group">
            <button disabled={layoutSelectionCount < 2} title={tr(locale, "左对齐", "Align left")} onClick={() => layoutSelectedNodes("left")}>
              <AlignStartVertical size={13} />
            </button>
            <button disabled={layoutSelectionCount < 2} title={tr(locale, "水平居中", "Center horizontally")} onClick={() => layoutSelectedNodes("horizontal-center")}>
              <AlignCenterVertical size={13} />
            </button>
            <button disabled={layoutSelectionCount < 2} title={tr(locale, "右对齐", "Align right")} onClick={() => layoutSelectedNodes("right")}>
              <AlignEndVertical size={13} />
            </button>
            <button disabled={layoutSelectionCount < 2} title={tr(locale, "顶对齐", "Align top")} onClick={() => layoutSelectedNodes("top")}>
              <AlignStartHorizontal size={13} />
            </button>
            <button disabled={layoutSelectionCount < 2} title={tr(locale, "垂直居中", "Center vertically")} onClick={() => layoutSelectedNodes("vertical-center")}>
              <AlignCenterHorizontal size={13} />
            </button>
            <button disabled={layoutSelectionCount < 2} title={tr(locale, "底对齐", "Align bottom")} onClick={() => layoutSelectedNodes("bottom")}>
              <AlignEndHorizontal size={13} />
            </button>
          </div>
          <div className="dashboard-tool-group">
            <button
              className="wide"
              disabled={layoutSelectionCount < 3}
              title={tr(locale, "水平等距分布", "Distribute horizontally")}
              onClick={() => layoutSelectedNodes("horizontal")}
            >
              {tr(locale, "横向等距", "H distribute")}
            </button>
            <button
              className="wide"
              disabled={layoutSelectionCount < 3}
              title={tr(locale, "垂直等距分布", "Distribute vertically")}
              onClick={() => layoutSelectedNodes("vertical")}
            >
              {tr(locale, "纵向等距", "V distribute")}
            </button>
          </div>
        </div>
        <div>
          <button
            title={tr(locale, "聚焦页面中的可见组件", "Focus visible components")}
            disabled={!page.nodes.some((node) => node.visible !== false)}
            onClick={() => fitCanvasToViewport("content")}
          >
            <Focus size={13} />
          </button>
          <button title={tr(locale, "完整显示看板", "Fit dashboard")} onClick={() => fitCanvasToViewport("page")}>
            <Scaling size={13} />
          </button>
          <button title={tr(locale, "缩小（以视口中心缩放）", "Zoom out around viewport center")} onClick={() => changeZoom(zoom - 0.1)}>
            <Minus size={13} />
          </button>
          <output>{Math.round(zoom * 100)}%</output>
          <button title={tr(locale, "放大（以视口中心缩放）", "Zoom in around viewport center")} onClick={() => changeZoom(zoom + 0.1)}>
            <Plus size={13} />
          </button>
        </div>
      </div>
      <div
        className={`dashboard-canvas-scroll ${panning ? "panning" : ""}`}
        ref={scrollRef}
        onScroll={handleCanvasScroll}
        onWheel={zoomCanvas}
        onPointerDownCapture={beginCanvasPan}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            setSelectedNodeIds([]);
            onSelectionChange([]);
          }
        }}
      >
        <div className="dashboard-artboard-stage" style={{ width: stageWidth, height: stageHeight }}>
          <button
            className="dashboard-ruler-corner"
            title={tr(locale, "清空参考线", "Clear guides")}
            disabled={(page.guides?.length ?? 0) === 0}
            onClick={() => onCommand(createUpdateDashboardPageGuidesCommand(page.id, []))}
          />
          <DashboardRuler
            orientation="horizontal"
            length={page.width}
            viewportLength={surfaceSize.width}
            zoom={zoom}
            offset={artboardOffsetX - viewportScroll.left}
            onPointerDown={(event) => addGuide("vertical", event)}
          />
          <DashboardRuler
            orientation="vertical"
            length={page.height}
            viewportLength={surfaceSize.height}
            zoom={zoom}
            offset={artboardOffsetY - viewportScroll.top}
            onPointerDown={(event) => addGuide("horizontal", event)}
          />
          <div
            ref={artboardRef}
            className={`dashboard-artboard ${marqueeMode ? "marquee-mode" : ""} ${libraryDropActive ? "library-drop-active" : ""}`}
            style={{
              width: page.width,
              height: page.height,
              left: artboardOffsetX,
              top: artboardOffsetY,
              transform: `scale(${zoom})`,
              ...dashboardBackgroundStyle(page.appearance),
            }}
            onDragEnter={allowLibraryDrop}
            onDragOver={allowLibraryDrop}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setLibraryDropActive(false);
            }}
            onDrop={dropLibraryItem}
            onPointerDownCapture={beginMarqueeSelection}
          >
            {page.nodes.length === 0 && (
              <EditorEmptyState
                icon={<LayoutTemplate size={20} />}
                title={tr(locale, "从一个清晰的起点开始", "Start from a clear foundation")}
                description={tr(locale, "使用行业模板快速形成完整布局，或从左侧选择组件自由搭建。", "Use an industry template for a complete layout, or build freely from the component library.")}
                primaryAction={{ label: tr(locale, "选择行业模板", "Choose a template"), icon: <LayoutTemplate size={13} />, onClick: () => setTemplateLibraryOpen(true) }}
                secondaryAction={{
                  label: tr(locale, "浏览组件", "Browse components"),
                  icon: <Shapes size={13} />,
                  onClick: () => {
                    setLeftPanelTab("components");
                    window.requestAnimationFrame(() => componentSearchRef.current?.focus());
                  },
                }}
                hint={tr(locale, "也可以把左侧组件直接拖到画布", "You can also drag components directly from the left panel")}
                variant="canvas"
                displayScale={1 / zoom}
              />
            )}
            {page.nodes
              .filter((node) => node.visible !== false)
              .map((node) => (
                <DashboardNode
                  key={node.id}
                  application={application}
                  project={project}
                  node={node}
                  frame={draftFrames[node.id] ?? node.frame}
                  metric={node.kind === "data-widget" ? runtimeMetrics[node.widget.key] : undefined}
                  variables={variables}
                  filters={filters}
                  selected={selectedNodeIds.includes(node.id)}
                  locale={locale}
                  rendererBackend={rendererBackend}
                  onFilterChange={onFilterChange}
                  onVariableChange={onVariableChange}
                  onSelectionChange={onSelectionChange}
                  onObjectInteraction={onObjectInteraction}
                  onInteraction={(trigger, payload) => onNodeInteraction(node.id, trigger, payload)}
                  onSelect={(additive) => selectNode(node, additive)}
                  onContextMenu={(event) => openNodeContextMenu(event, node)}
                  onEnterScene={(sceneId) => onEnterScene(sceneId, currentView())}
                  onTransformStart={(event, mode) => beginNodeTransform(event, node, mode)}
                />
              ))}
            {guidesVisible &&
              (draftGuides ?? page.guides ?? []).map((guide) => (
                <button
                  key={guide.id}
                  className={`dashboard-guide ${guide.orientation}`}
                  style={guide.orientation === "vertical" ? { left: guide.position } : { top: guide.position }}
                  title={tr(locale, "拖动调整，拖出画布删除", "Drag to move; drag outside to delete")}
                  onPointerDown={(event) => beginGuideDrag(event, guide)}
                />
              ))}
            {activeSnapLines.x.map((position) => (
              <div key={`x:${position}`} className="dashboard-smart-guide vertical" style={{ left: position }} />
            ))}
            {activeSnapLines.y.map((position) => (
              <div key={`y:${position}`} className="dashboard-smart-guide horizontal" style={{ top: position }} />
            ))}
            {selectionRect && (
              <div
                className="dashboard-selection-rect"
                style={{
                  left: selectionRect.x,
                  top: selectionRect.y,
                  width: selectionRect.width,
                  height: selectionRect.height,
                }}
              />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
