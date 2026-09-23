import {
  useEffect,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Box, GripVertical, Scaling, Workflow } from "lucide-react";
import {
  type ApplicationDocument,
  type ApplicationObjectRef,
  type JsonValue,
  type ProjectRecord,
  type SceneInteractionTarget,
  type SceneInteractionTrigger,
  type WidgetFrame,
  type WidgetNode,
} from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import type { RendererBackend } from "../viewer/ViewerEngine";
import { resolveDashboardAnimationLoop } from "./dashboardAnimationPlayback";
import { dataWidgetTypeLabel } from "./dashboardWorkspaceModel";
import {
  dashboardLinkageValue,
  DashboardWidgetView,
  widgetBackgroundStyle,
  type DashboardMetric,
} from "./DashboardWidgetRuntime";
import { SceneViewportPreview } from "./SceneViewportPreview";
import { UnitySceneEmbed } from "./UnitySceneEmbed";
import { usePlaybackSession } from "../behavior/playbackContext";
import { publicWidgetRestriction } from "../behavior/publicPlaybackPolicy";
import { isSemanticSelectionWidget, semanticSelectionKey } from "./dashboardSemanticBinding";
import { dashboardAuthoredTypography } from "./dashboardTemplateTypography";
import { dashboardWidgetTextColor } from "./dashboardWidgetTextColor";
import { DashboardRecordForm } from "./DashboardRecordForm";
import "./DashboardTemplateTypography.css";

export function DashboardNode({
  application,
  project,
  node,
  frame,
  metric,
  variables,
  filters,
  selected,
  locale,
  rendererBackend,
  runtime = false,
  onFilterChange,
  onVariableChange,
  onSelectionChange,
  onObjectInteraction,
  onInteraction,
  onSelect,
  onContextMenu,
  onEnterScene,
  onTransformStart,
}: {
  application: ApplicationDocument;
  project: ProjectRecord;
  node: WidgetNode;
  frame: WidgetFrame;
  metric: DashboardMetric | undefined;
  variables: Readonly<Record<string, JsonValue>>;
  filters: Readonly<Record<string, JsonValue>>;
  selected: boolean;
  locale: AppLocale;
  rendererBackend: RendererBackend;
  runtime?: boolean;
  onFilterChange: (key: string, value: JsonValue | undefined) => void;
  onVariableChange: (key: string, value: JsonValue) => void;
  onSelectionChange: (selection: readonly ApplicationObjectRef[]) => void;
  onObjectInteraction: (
    sceneId: string,
    trigger: SceneInteractionTrigger,
    target: SceneInteractionTarget,
  ) => void;
  onInteraction: (
    trigger: SceneInteractionTrigger,
    payload?: JsonValue,
  ) => void;
  onSelect: (additive: boolean) => void;
  onContextMenu?: (event: ReactMouseEvent) => void;
  onEnterScene: (sceneId: string) => void;
  onTransformStart: (
    event: ReactPointerEvent<HTMLButtonElement>,
    mode: "move" | "resize",
  ) => void;
}) {
  const playback = usePlaybackSession();
  const style = {
    left: frame.x,
    top: frame.y,
    width: frame.width,
    height: frame.height,
    zIndex: node.zIndex,
    ...(!runtime && node.selectable === false
      ? { pointerEvents: "none" as const }
      : {}),
  };
  useEffect(() => {
    if (!runtime || node.kind !== "data-widget") return;
    const task = window.setTimeout(() => onInteraction("load"), 0);
    return () => window.clearTimeout(task);
  }, [node.id, runtime]);
  if (node.kind === "scene-viewport") {
    const scene = application.scenes.find(
      (candidate) => candidate.id === node.sceneId,
    );
    return (
      <article
        className={`dashboard-node dashboard-scene-viewport ${selected ? "selected" : ""} ${runtime ? "runtime" : ""}`}
        style={style}
        onClick={(event) => {
          event.stopPropagation();
          if (!runtime) onSelect(event.ctrlKey || event.metaKey || event.shiftKey);
        }}
        onDoubleClick={(event) => {
          if (!runtime && scene) {
            event.stopPropagation();
            onEnterScene(scene.id);
          }
        }}
        onContextMenu={(event) => {
          if (!runtime) onContextMenu?.(event);
        }}
      >
        {scene && node.renderMode !== "static-placeholder" ? (
          <SceneViewportPreview
            locale={locale}
            node={node}
            scene={scene}
            project={project}
            rendererBackend={rendererBackend}
            runtime={runtime}
            onSelectionChange={onSelectionChange}
            onObjectInteraction={(trigger, target) => {
              if (runtime) onObjectInteraction(scene.id, trigger, target);
            }}
          />
        ) : (
          <div className="dashboard-scene-grid" />
        )}
        {!runtime && (
          <button
            className="dashboard-scene-edit-hit-target"
            aria-label={tr(locale, "选择三维组件；双击进入三维编辑", "Select 3D component; double-click to edit in 3D")}
            title={tr(locale, "双击进入三维编辑", "Double-click to edit in 3D")}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(event.ctrlKey || event.metaKey || event.shiftKey);
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              if (scene) onEnterScene(scene.id);
            }}
          />
        )}
        {!runtime && (
          <>
            <div className="dashboard-scene-summary">
              <span>
                <Box size={36} />
              </span>
              <strong>{scene?.name ?? node.sceneId}</strong>
              <small>
                {scene
                  ? `${scene.models.length + scene.primitives.length} ${tr(locale, "个场景对象", "scene objects")}`
                  : tr(locale, "场景引用缺失", "Missing scene reference")}
              </small>
            </div>
            <div className="dashboard-node-badge">3D · {node.renderMode}</div>
            <NodeTransformHandles
              selected={selected && node.locked !== true}
              onTransformStart={onTransformStart}
            />
          </>
        )}
      </article>
    );
  }
  if (node.kind === "data-widget") {
    const typography = dashboardAuthoredTypography(node.widget);
    const animationEnabled = runtime && node.widget.animationAutoplay !== false;
    const restriction = playback?.allowsProtectedData === false ? publicWidgetRestriction(node.widget, metric?.value !== undefined) : undefined;
    const keyboardInteractive = runtime && ["text", "shape", "decoration", "image", "value", "status"].includes(node.widget.type)
      && (application.interactions.some(flow => flow.enabled && flow.source.kind === "widget" && flow.source.id === node.id && flow.trigger === "click")
        || application.scripts.some(script => script.enabled && script.target?.kind === "component" && script.target.id === node.id && script.lifecycle?.includes("onEvent")));
    return (
      <article
        className={`dashboard-node dashboard-native-widget ${typography ? "authored-typography" : ""} ${selected ? "selected" : ""} ${animationEnabled ? `runtime animation-${node.widget.animation ?? "none"}` : runtime ? "runtime" : ""}`}
        role={keyboardInteractive ? "button" : undefined}
        tabIndex={keyboardInteractive ? 0 : undefined}
        aria-label={keyboardInteractive ? node.widget.title || node.name : undefined}
        style={{
          ...style,
          ...widgetBackgroundStyle(node.widget),
          ...typography,
          color: dashboardWidgetTextColor(node.widget),
          animationDuration: `${node.widget.animationDuration ?? 0.6}s`,
          animationDelay: `${node.widget.animationDelay ?? 0}s`,
          animationIterationCount: resolveDashboardAnimationLoop(node.widget) ? "infinite" : "1",
          ...(restriction ? { background: "var(--panel)", color: "var(--text)" } : {}),
        }}
        onKeyDown={(event) => {
          if (keyboardInteractive && event.target === event.currentTarget && !event.repeat && ["Enter", " "].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            onInteraction("click");
          }
        }}
        onClick={(event) => {
          event.stopPropagation();
          runtime
            ? onInteraction("click")
            : onSelect(event.ctrlKey || event.metaKey || event.shiftKey);
        }}
        onDoubleClick={(event) => {
          if (runtime) {
            event.stopPropagation();
            onInteraction("doubleClick");
          }
        }}
        onContextMenu={(event) => {
          if (runtime) {
            event.preventDefault();
            event.stopPropagation();
            onInteraction("contextMenu");
          } else onContextMenu?.(event);
        }}
        onPointerEnter={() => {
          if (runtime) onInteraction("pointerEnter");
        }}
        onPointerLeave={() => {
          if (runtime) onInteraction("pointerLeave");
        }}
        onAnimationStart={() => {
          if (runtime) onInteraction("animationStart");
        }}
        onAnimationEnd={() => {
          if (runtime) onInteraction("animationEnd");
        }}
      >
        {node.widget.type === "record-form" ? (
          <DashboardRecordForm widget={node.widget} projectId={project.id} locale={locale} runtime={runtime} />
        ) : restriction ? <div className="dashboard-public-restriction" role="note"><strong>{node.widget.title || node.name}</strong><span>{restriction}</span></div> : node.widget.type === "topology" ? (
          <DashboardTopologyView
            application={application}
            {...(node.widget.topologyId
              ? { topologyId: node.widget.topologyId }
              : {})}
          />
        ) : node.widget.type === "unity" ? (
          <UnitySceneEmbed
            locale={locale}
            widgetId={node.id}
            widget={node.widget}
            variables={variables}
            filters={filters}
            {...(metric?.value !== undefined
              ? { data: metric.value as JsonValue }
              : {})}
            {...(metric ? { dataContext: unityMetricContext(metric) } : {})}
            compact={!runtime}
            onEvent={(eventName, payload) => {
              const eventPayload: JsonValue = {
                eventName,
                data: payload ?? null,
              };
              onVariableChange(
                `unity.${node.widget.key || node.id}.${eventName}`,
                payload ?? true,
              );
              onInteraction("click", eventPayload);
            }}
          />
        ) : (
          <DashboardWidgetView
            projectId={project.id}
            locale={locale}
            widget={node.widget}
            metric={metric}
            compact={!runtime}
            filters={filters}
            {...(filters[node.widget.key] !== undefined
              ? { filterValue: filters[node.widget.key] }
              : {})}
            onFilterChange={onFilterChange}
            onDataInteraction={(payload) => {
              const linkageValue = dashboardLinkageValue(payload);
              const semanticPath = payload && typeof payload === "object" && !Array.isArray(payload) && Array.isArray(payload.semanticPath) ? payload.semanticPath : undefined;
              if (runtime && node.widget.semanticBinding?.autoLink !== false && node.widget.semanticBinding && metric?.semanticWidget?.analysis?.dimensionField && isSemanticSelectionWidget(node.widget) && (linkageValue !== undefined || semanticPath?.length === 0)) {
                const field = payload && typeof payload === "object" && !Array.isArray(payload) && typeof payload.semanticField === "string" ? payload.semanticField : metric.semanticWidget.analysis.dimensionField;
                const path = semanticPath ?? [{ field, value: linkageValue ?? null }];
                onFilterChange(semanticSelectionKey(node.widget), path.length ? { field, value: linkageValue ?? null, path } : undefined);
              }
              if (
                node.widget.linkageParameterKey?.trim() &&
                linkageValue !== undefined
              )
                onFilterChange(
                  node.widget.linkageParameterKey.trim(),
                  linkageValue,
                );
              onInteraction("click", payload);
            }}
            onAnimationStart={() => onInteraction("animationStart")}
            onAnimationEnd={() => onInteraction("animationEnd")}
          />
        )}
        {!runtime && (
          <>
            <div className="dashboard-node-badge">
              {dataWidgetTypeLabel(locale, node.widget.type)}
            </div>
            <NodeTransformHandles
              selected={selected && node.locked !== true}
              onTransformStart={onTransformStart}
            />
          </>
        )}
      </article>
    );
  }
  return null;
}

function unityMetricContext(metric: DashboardMetric): JsonValue {
  return {
    value: metric.value as JsonValue,
    rows: (metric.rows ?? []) as unknown as JsonValue,
    samples: metric.samples as unknown as JsonValue,
  };
}
function NodeTransformHandles({
  selected,
  onTransformStart,
}: {
  selected: boolean;
  onTransformStart: (
    event: ReactPointerEvent<HTMLButtonElement>,
    mode: "move" | "resize",
  ) => void;
}) {
  return selected ? (
    <>
      <button
        className="dashboard-node-move-handle"
        aria-label="移动组件"
        onPointerDown={(event) => onTransformStart(event, "move")}
      >
        <GripVertical size={13} />
      </button>
      <button
        className="dashboard-node-resize-handle"
        aria-label="缩放组件"
        onPointerDown={(event) => onTransformStart(event, "resize")}
      >
        <Scaling size={12} />
      </button>
    </>
  ) : null;
}
function DashboardTopologyView({
  application,
  topologyId,
}: {
  application: ApplicationDocument;
  topologyId?: string;
}) {
  const topology = application.topologies.find(
    (candidate) => candidate.id === topologyId,
  );
  if (!topology)
    return (
      <div className="dashboard-topology-empty">
        <Workflow size={24} />
        <span>选择拓扑文档</span>
        <small>选中此组件后，在右侧属性中绑定要展示的拓扑视图</small>
      </div>
    );
  const bounds = topology.nodes.reduce(
    (result, node) => ({
      minX: Math.min(result.minX, node.x),
      minY: Math.min(result.minY, node.y),
      maxX: Math.max(result.maxX, node.x + 164),
      maxY: Math.max(result.maxY, node.y + 68),
    }),
    { minX: 0, minY: 0, maxX: 640, maxY: 360 },
  );
  const width = Math.max(320, bounds.maxX - bounds.minX + 80);
  const height = Math.max(180, bounds.maxY - bounds.minY + 80);
  return (
    <div className="dashboard-topology-widget">
      <header>
        <Workflow size={14} />
        <strong>{topology.name}</strong>
        <span>
          {topology.nodes.length} nodes · {topology.edges.length} links
        </span>
      </header>
      <svg
        viewBox={`${bounds.minX - 40} ${bounds.minY - 40} ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
      >
        {topology.edges.map((edge) => {
          const source = topology.nodes.find(
            (node) => node.id === edge.sourceNodeId,
          );
          const target = topology.nodes.find(
            (node) => node.id === edge.targetNodeId,
          );
          return source && target ? (
            <line
              key={edge.id}
              x1={source.x + 82}
              y1={source.y + 34}
              x2={target.x + 82}
              y2={target.y + 34}
            />
          ) : null;
        })}
        {topology.nodes.map((node) => (
          <g key={node.id} transform={`translate(${node.x} ${node.y})`}>
            <rect width="164" height="68" rx="10" />
            <circle
              cx="20"
              cy="34"
              r="6"
              className={topologyNodeHasBinding(node) ? "bound" : ""}
            />
            <text x="34" y="31">
              {String(node.properties.label ?? node.kind)}
            </text>
            <text x="34" y="46" className="kind">
              {node.kind}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
function topologyNodeHasBinding(
  node: ApplicationDocument["topologies"][number]["nodes"][number],
): boolean {
  return Boolean(
    node.properties.dataBinding &&
      typeof node.properties.dataBinding === "object",
  );
}
