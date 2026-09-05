import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Copy,
  Download,
  ExternalLink,
  Printer,
  Rocket,
  SlidersHorizontal,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  type ApplicationDocument,
  type ApplicationObjectRef,
  type DashboardPageDocument,
  type JsonValue,
  type ProjectRecord,
  type SceneInteractionTarget,
  type SceneInteractionTrigger,
} from "@bim-studio/contracts";
import type { ApplicationInteractionResult } from "@bim-studio/studio-core";
import { translate as tr, type AppLocale } from "../i18n";
import type { RendererBackend } from "../viewer/ViewerEngine";
import { dashboardBackgroundStyle } from "./dashboardCanvasStyle";
import { DashboardNode } from "./DashboardCanvasNode";
import { downloadDashboardPageData } from "./dashboardPageExport";
import {
  calculateDashboardRuntimeViewport,
  updateDashboardParameterDraft,
  type DashboardRuntimeViewport,
} from "./dashboardWorkspaceModel";
import {
  DashboardWidgetView,
  type DashboardMetric,
} from "./DashboardWidgetRuntime";

export function DashboardRuntimePreview({
  locale,
  application,
  project,
  page,
  rendererBackend,
  metrics,
  variables,
  filters,
  connected,
  onFilterChange,
  onVariableChange,
  onSelectPage,
  onClose,
  onPublish,
  onSelectionChange,
  onObjectInteraction,
  onNodeInteraction,
  children,
}: {
  locale: AppLocale;
  application: ApplicationDocument;
  project: ProjectRecord;
  page: DashboardPageDocument;
  rendererBackend: RendererBackend;
  metrics: Record<string, DashboardMetric>;
  variables: Readonly<Record<string, JsonValue>>;
  filters: Readonly<Record<string, JsonValue>>;
  connected: boolean;
  children?: ReactNode;
  onSelectPage: (pageId: string) => void;
  onClose: () => void;
  onPublish: () => void;
  onSelectionChange: (selection: readonly ApplicationObjectRef[]) => void;
  onFilterChange: (key: string, value: JsonValue | undefined) => void;
  onVariableChange: (key: string, value: JsonValue) => void;
  onObjectInteraction: (
    sceneId: string,
    trigger: SceneInteractionTrigger,
    target: SceneInteractionTarget,
  ) => void;
  onNodeInteraction: (
    nodeId: string,
    trigger?: SceneInteractionTrigger,
    payload?: JsonValue,
  ) => ApplicationInteractionResult | undefined;
}) {
  const [controlsOpen, setControlsOpen] = useState(false);
  const parameterWidgets = useMemo(
    () =>
      page.nodes.flatMap((node) =>
        node.kind === "data-widget" && node.widget.type === "filter"
          ? [node.widget]
          : [],
      ),
    [page.nodes],
  );
  const [parametersOpen, setParametersOpen] = useState(
    parameterWidgets.length > 0,
  );
  const [draftFilters, setDraftFilters] = useState<Record<string, JsonValue>>(
    () => ({ ...filters }),
  );
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState("");
  const [viewport, setViewport] = useState<DashboardRuntimeViewport>(() =>
    calculateDashboardRuntimeViewport(
      page,
      page.width * 0.5 + 32,
      page.height * 0.5 + 32,
    ),
  );
  const surfaceRef = useRef<HTMLDivElement>(null);
  useEffect(() => setDraftFilters({ ...filters }), [filters]);
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const resize = () =>
      setViewport(
        calculateDashboardRuntimeViewport(
          page,
          surface.clientWidth,
          surface.clientHeight,
        ),
      );
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [page.width, page.height, page.viewportFit]);

  function updateDraftFilter(key: string, value: JsonValue | undefined) {
    setDraftFilters((current) =>
      updateDashboardParameterDraft(current, parameterWidgets, key, value),
    );
  }
  function applyParameters() {
    for (const widget of parameterWidgets)
      onFilterChange(widget.key, draftFilters[widget.key]);
  }
  function resetParameters() {
    const next = { ...draftFilters };
    for (const widget of parameterWidgets) {
      delete next[widget.key];
      onFilterChange(widget.key, undefined);
    }
    setDraftFilters(next);
  }
  async function exportPageData() {
    setExportBusy(true);
    setExportError("");
    try {
      await downloadDashboardPageData(page, metrics, filters);
    } catch (reason) {
      setExportError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setExportBusy(false);
    }
  }

  const activeParameterCount = parameterWidgets.filter(
    (widget) => draftFilters[widget.key] !== undefined,
  ).length;
  return (
    <main className="dashboard-runtime-preview">
      <button
        type="button"
        className="dashboard-runtime-back"
        title={tr(locale, "返回编辑（Esc）", "Back to editor (Esc)")}
        onClick={onClose}
      >
        <ArrowLeft size={15} />
        {tr(locale, "返回编辑", "Back to editor")}
      </button>
      <section
        ref={surfaceRef}
        className={`dashboard-runtime-surface fit-${page.viewportFit}`}
      >
        <div
          className="dashboard-runtime-stage"
          style={{ width: viewport.stageWidth, height: viewport.stageHeight }}
        >
          <div
            className="dashboard-artboard dashboard-runtime-artboard"
            style={{
              width: page.width,
              height: page.height,
              left: viewport.offsetX,
              top: viewport.offsetY,
              transform: `scale(${viewport.scaleX}, ${viewport.scaleY})`,
              ...dashboardBackgroundStyle(page.appearance),
            }}
          >
            {page.nodes
              .filter((node) => node.visible !== false)
              .map((node) => (
                <DashboardNode
                  key={node.id}
                  runtime
                  application={application}
                  project={project}
                  node={node}
                  frame={node.frame}
                  metric={
                    node.kind === "data-widget"
                      ? metrics[node.widget.key]
                      : undefined
                  }
                  variables={variables}
                  filters={filters}
                  selected={false}
                  locale={locale}
                  rendererBackend={rendererBackend}
                  onFilterChange={onFilterChange}
                  onVariableChange={onVariableChange}
                  onSelectionChange={onSelectionChange}
                  onObjectInteraction={onObjectInteraction}
                  onInteraction={(trigger, payload) =>
                    onNodeInteraction(node.id, trigger, payload)
                  }
                  onSelect={() => undefined}
                  onEnterScene={() => undefined}
                  onTransformStart={() => undefined}
                />
              ))}
          </div>
        </div>
      </section>
      {parametersOpen && parameterWidgets.length > 0 && (
        <aside
          className="dashboard-runtime-parameters"
          aria-label={tr(locale, "参数查询", "Parameter query")}
        >
          <header>
            <span>
              <SlidersHorizontal size={14} />
              <strong>{tr(locale, "参数查询", "Parameters")}</strong>
              <small>
                {activeParameterCount}/{parameterWidgets.length}
              </small>
            </span>
            <button
              type="button"
              aria-label={tr(locale, "收起参数", "Collapse parameters")}
              onClick={() => setParametersOpen(false)}
            >
              <X size={13} />
            </button>
          </header>
          <div>
            {parameterWidgets.map((widget) => (
              <DashboardWidgetView
                key={widget.key}
                locale={locale}
                widget={widget}
                metric={undefined}
                compact={false}
                filters={draftFilters}
                {...(draftFilters[widget.key] === undefined
                  ? {}
                  : { filterValue: draftFilters[widget.key] })}
                onFilterChange={updateDraftFilter}
                onDataInteraction={() => undefined}
                onAnimationStart={() => undefined}
                onAnimationEnd={() => undefined}
              />
            ))}
          </div>
          <footer>
            <button type="button" onClick={resetParameters}>
              {tr(locale, "重置", "Reset")}
            </button>
            <button type="button" className="primary" onClick={applyParameters}>
              {tr(locale, "查询", "Apply")}
            </button>
          </footer>
        </aside>
      )}
      <div
        className={`dashboard-runtime-controller ${controlsOpen ? "open" : ""}`}
      >
        <button
          className="dashboard-runtime-controller-trigger"
          title={tr(locale, "项目控制", "Project controls")}
          aria-label={tr(locale, "项目控制", "Project controls")}
          aria-expanded={controlsOpen}
          onClick={() => setControlsOpen((open) => !open)}
        >
          <ExternalLink size={15} />
          <span>{application.metadata.name}</span>
        </button>
        {controlsOpen && (
          <div className="dashboard-runtime-controller-panel">
            <header>
              <strong>{application.metadata.name}</strong>
              <small>
                {page.name} ·{" "}
                {connected
                  ? tr(locale, "实时数据", "Live data")
                  : tr(locale, "离线数据", "Offline data")}
              </small>
            </header>
            {application.pages.length > 1 && (
              <nav aria-label={tr(locale, "页面", "Pages")}>
                {application.pages.map((candidate) => (
                  <button
                    className={candidate.id === page.id ? "active" : ""}
                    key={candidate.id}
                    onClick={() => onSelectPage(candidate.id)}
                  >
                    {candidate.name}
                  </button>
                ))}
              </nav>
            )}
            <div>
              {parameterWidgets.length > 0 && (
                <button onClick={() => setParametersOpen((open) => !open)}>
                  <SlidersHorizontal size={13} />
                  {tr(locale, "参数", "Parameters")}{" "}
                  {activeParameterCount > 0 && <b>{activeParameterCount}</b>}
                </button>
              )}
              <button
                disabled={exportBusy}
                onClick={() => void exportPageData()}
              >
                <Download size={13} />
                {exportBusy
                  ? tr(locale, "导出中", "Exporting")
                  : tr(locale, "导出数据", "Export data")}
              </button>
              <button onClick={() => window.print()}>
                <Printer size={13} />
                {tr(locale, "打印", "Print")}
              </button>
              <button onClick={onPublish}>
                <Rocket size={13} />
                {tr(locale, "发布更新", "Publish update")}
              </button>
              <button
                onClick={() =>
                  void navigator.clipboard.writeText(
                    `${window.location.origin}/apps/${encodeURIComponent(application.metadata.id)}`,
                  )
                }
              >
                <Copy size={13} />
                {tr(locale, "复制发布链接", "Copy published URL")}
              </button>
              <button onClick={onClose}>
                <X size={13} />
                {tr(locale, "返回编辑", "Back to editor")}
              </button>
            </div>
            {exportError && (
              <p className="dashboard-runtime-export-error">
                <TriangleAlert size={12} />
                {exportError}
              </p>
            )}
          </div>
        )}
      </div>
      {children}
    </main>
  );
}
