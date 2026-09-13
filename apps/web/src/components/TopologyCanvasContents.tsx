import { AlertTriangle, Box, Database, Layers3 } from "lucide-react";
import { assessTopologyScadaRuntime, isTopologyScadaNode, topologyNodeDataBinding, topologyNodeLabel, topologyNodeScadaConfig } from "@bim-studio/studio-core";
import { translate as tr } from "../i18n";
import type { TopologyNode } from "@bim-studio/contracts";
import type { TopologyEditorController } from "./TopologyEditorPanel";
import { TopologyIsoDevice } from "./TopologyIsoDevice";
import { topologyConnectionPath, topologyZones, topologyZoneOutline } from "./topologySpatialGeometry";
import { formatScadaValue, qualityLabel, runtimeAssessmentLabel, scadaStateLabel, topologyEdgeAnimated, topologyEdgeLabel, topologyEdgeMedium, topologyEdgeStateClass, topologyNodeElevation, topologyProjectedPosition } from "./topologyEditorRuntime";

export function TopologyCanvasContents({ controller, focusZone, isDimmed }: {
  controller: TopologyEditorController; focusZone: string; isDimmed: (node: TopologyNode) => boolean;
}) {
  const { CANVAS_WIDTH, CANVAS_HEIGHT, markerId, edgeGeometry, selection, runtimeStates, viewMode, drag, dragPosition,
    dispatch, editor, selectedNodeIds, connectionSourceId, runtimeNowMs, runtimeStaleAfterMs, NODE_PRESETS, selectNode,
    beginDrag, moveDrag, endDrag, locale } = controller;
  const zones = topologyZones(editor.document.nodes);
  return <><svg className="topology-editor__edges" width={CANVAS_WIDTH} height={CANVAS_HEIGHT} aria-hidden="true">
            <defs>
              <marker id={markerId} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            </defs>
            {viewMode === "2.5d" && zones.map(zone => <g key={zone.name} className={`topology-spatial-zone ${focusZone && focusZone !== zone.name ? "is-dimmed" : ""}`}>
              <polygon points={topologyZoneOutline(zone.nodes)} />
              <text x={Math.min(...zone.nodes.map(node => topologyProjectedPosition(node, viewMode).x)) - 12} y={Math.min(...zone.nodes.map(node => topologyProjectedPosition(node, viewMode).y)) + 26}>{zone.name}</text>
            </g>)}
            {edgeGeometry.map(({ edge, source, target }) => {
              const selected = selection?.kind === "edge" && selection.id === edge.id;
              const medium = topologyEdgeMedium(edge);
              const animated = topologyEdgeAnimated(edge);
              const stateClass = topologyEdgeStateClass(runtimeStates[source.id], runtimeStates[target.id]);
              const liveSource = drag?.nodeId === source.id && dragPosition ? { ...source, ...dragPosition } : source;
              const liveTarget = drag?.nodeId === target.id && dragPosition ? { ...target, ...dragPosition } : target;
              const { path, labelX, labelY } = topologyConnectionPath(liveSource, liveTarget, viewMode);
              const label = topologyEdgeLabel(edge);
              return (
                <g
                  key={edge.id}
                  className={`${selected ? "is-selected" : ""} is-${medium} ${animated ? "is-animated" : ""} ${stateClass} ${isDimmed(source) || isDimmed(target) ? "is-dimmed" : ""}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    dispatch({ type: "selection.set", selection: [{ kind: "edge", id: edge.id }] });
                  }}
                >
                  <path className="topology-editor__edge-hit" d={path} />
                  <path className="topology-editor__edge-line" d={path} markerEnd={`url(#${markerId})`} />
                  {label && (
                    <text className="topology-editor__edge-label" x={labelX} y={labelY} textAnchor="middle">
                      {label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {editor.document.nodes.map((node) => {
            const selected = selectedNodeIds.includes(node.id);
            const connecting = connectionSourceId === node.id;
            const nodeBinding = topologyNodeDataBinding(node);
            const scada = isTopologyScadaNode(node);
            const runtimeState = runtimeStates[node.id];
            const runtimeAssessment = assessTopologyScadaRuntime(runtimeState, runtimeNowMs, runtimeStaleAfterMs);
            const operatingState = runtimeState?.state ?? "unknown";
            const basePosition = drag?.nodeId === node.id && dragPosition ? { ...node, ...dragPosition } : node;
            const position = topologyProjectedPosition(basePosition, viewMode);
            const elevation = topologyNodeElevation(node);
            const Icon = NODE_PRESETS.find((preset) => preset.kind === node.kind)?.icon ?? Box;
            const nodeClassName = [
              "topology-editor__node",
              selected && "is-selected",
              isDimmed(node) && "is-dimmed",
              connecting && "is-source",
              scada && `is-scada is-state-${operatingState} is-freshness-${runtimeAssessment.freshness}`,
              scada && runtimeState && `is-quality-${runtimeAssessment.quality}`,
              runtimeState?.alarm?.active && "has-alarm",
              runtimeState?.alarm?.active && `is-alarm-${runtimeState.alarm.severity}`,
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={node.id}
                className={nodeClassName}
                style={{ left: position.x, top: position.y }}
                title={topologyNodeLabel(node)}
                aria-pressed={selected}
                onClick={(event) => {
                  event.stopPropagation();
                  selectNode(node.id, event.shiftKey || event.ctrlKey || event.metaKey);
                }}
                onPointerDown={(event) => beginDrag(event, node)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                {viewMode === "2.5d" && <TopologyIsoDevice node={node} />}
                <span className="topology-editor__port topology-editor__port--in" />
                <span className="topology-editor__node-icon">
                  <Icon size={18} />
                </span>
                <span className="topology-editor__node-copy">
                  <strong>{topologyNodeLabel(node)}</strong>
                  <small>{scada && <span aria-hidden="true">{operatingState === "running" ? "▶ " : operatingState === "offline" ? "⊘ " : operatingState === "alarm" || operatingState === "warning" ? "⚠ " : "○ "}</span>}{scada ? (runtimeState ? scadaStateLabel(locale, operatingState) : tr(locale, "待数据", "Awaiting data")) : node.kind}</small>
                  {scada && runtimeState?.value !== undefined && <em>{formatScadaValue(runtimeState.value, runtimeState.unit ?? topologyNodeScadaConfig(node)?.unit)}</em>}
                </span>
                {scada && (
                  <span
                    className={`topology-editor__status-dot is-${operatingState}`}
                    title={runtimeState ? `${scadaStateLabel(locale, operatingState)} · ${qualityLabel(locale, runtimeAssessment.quality)} · ${runtimeAssessmentLabel(locale, runtimeAssessment)}` : tr(locale, "等待实时数据，不代表设备离线", "Awaiting runtime data; not an offline diagnosis")}
                  />
                )}
                {runtimeState?.alarm?.active && (
                  <span className={`topology-editor__alarm-badge is-${runtimeState.alarm.severity}`} title={runtimeState.alarm.message}>
                    <AlertTriangle size={11} />
                  </span>
                )}
                {nodeBinding && (
                  <span className="topology-editor__binding-dot" title={tr(locale, "已绑定数据", "Data bound")}>
                    <Database size={11} />
                  </span>
                )}
                {viewMode === "2.5d" && elevation !== 0 && (
                  <span className="topology-editor__elevation"><Layers3 size={10} />H {elevation}</span>
                )}
                <span className="topology-editor__port topology-editor__port--out" />
              </button>
            );
          })}</>;
}
