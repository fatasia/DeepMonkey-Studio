import { useId } from "react";
import type { PlantLiteModel } from "@bim-studio/contracts";
import {
  buildPlantLiteMaterialFlowDiagram,
  type PlantLiteFlowDiagram,
  type PlantLiteFlowDiagramLink,
} from "./plantLiteMaterialFlowDiagramModel";
import type { PlantLiteEdgeFlow } from "./plantLiteMaterialFlowModel";

export function PlantLiteMaterialFlowDiagram({
  model,
  edgeFlows,
  truncated,
}: {
  model: PlantLiteModel;
  edgeFlows: PlantLiteEdgeFlow[];
  truncated: boolean;
}) {
  const titleId = `${useId().replace(/:/g, "")}-material-flow-title`;
  const wide = buildPlantLiteMaterialFlowDiagram(model, edgeFlows, "horizontal");
  const compact = buildPlantLiteMaterialFlowDiagram(model, edgeFlows, "vertical");

  return (
    <figure className={`plant-flow-diagram${truncated ? " is-truncated" : ""}`} aria-labelledby={titleId}>
      <figcaption id={titleId}>
        <span>
          <strong>已采集流向</strong>
          <small>{truncated ? "仅覆盖已采集轨迹，非全量运行" : "线宽反映已采集转移次数；0 次路径以虚线保留"}</small>
        </span>
        <span className="plant-flow-diagram-legend" aria-hidden="true">
          <i className="is-observed" />已采集
          <i className="is-empty" />0 次
          {wide.hasParallelRoutes ? <><i className="is-ambiguous" />并行边合计</> : null}
        </span>
      </figcaption>

      {wide.nodes.length > 0
        ? (
          <div className="plant-flow-diagram-canvas">
            <DiagramSvg diagram={wide} variant="wide" markerPrefix={`${titleId}-wide`} />
            <DiagramSvg diagram={compact} variant="compact" markerPrefix={`${titleId}-compact`} />
          </div>
        )
        : <p className="plant-flow-diagram-empty">当前模型没有可展示的节点。</p>}

      <ul className="sr-only">
        {wide.links.map((link) => <li key={link.id}>{linkAccessibleLabel(link, truncated)}</li>)}
        {truncated ? <li>轨迹已截断，本图只代表已采集事件，不代表全量运行。</li> : null}
      </ul>
    </figure>
  );
}

function DiagramSvg({
  diagram,
  variant,
  markerPrefix,
}: {
  diagram: PlantLiteFlowDiagram;
  variant: "wide" | "compact";
  markerPrefix: string;
}) {
  const exactMarker = `${markerPrefix}-exact`;
  const ambiguousMarker = `${markerPrefix}-ambiguous`;
  const emptyMarker = `${markerPrefix}-empty`;
  return (
    <svg
      className={`plant-flow-diagram-svg is-${variant}`}
      viewBox={`0 0 ${diagram.width} ${diagram.height}`}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <FlowArrowMarker id={exactMarker} className="is-exact" />
        <FlowArrowMarker id={ambiguousMarker} className="is-ambiguous" />
        <FlowArrowMarker id={emptyMarker} className="is-empty" />
      </defs>
      <g className="plant-flow-diagram-links">
        {diagram.links.map((link) => (
          <path
            key={link.id}
            className={`plant-flow-diagram-link is-${link.attribution}${link.capturedTransferCount === 0 ? " is-empty" : ""}`}
            d={link.path}
            style={{ strokeWidth: link.strokeWidth }}
            markerEnd={`url(#${link.capturedTransferCount === 0 ? emptyMarker : link.attribution === "exact" ? exactMarker : ambiguousMarker})`}
          />
        ))}
      </g>
      <g className="plant-flow-diagram-labels">
        {diagram.links.map((link) => (
          <g
            key={link.id}
            className={`plant-flow-diagram-count is-${link.attribution}${link.capturedTransferCount === 0 ? " is-empty" : ""}`}
            transform={`translate(${link.labelX} ${link.labelY})`}
          >
            <rect x={-link.labelWidth / 2} y={-8} width={link.labelWidth} height={16} rx={8} />
            <text textAnchor="middle" dominantBaseline="central">{link.capturedTransferCount}</text>
          </g>
        ))}
      </g>
      <g className="plant-flow-diagram-nodes">
        {diagram.nodes.map((node) => (
          <g key={node.id} className="plant-flow-diagram-node" data-kind={node.kind} transform={`translate(${node.x} ${node.y})`}>
            <title>{`${node.name}（${node.kind}）`}</title>
            <rect width={node.width} height={node.height} rx={5} />
            <path d={`M 1 5 Q 1 1 5 1 L 5 ${node.height - 1} L 1 ${node.height - 1} Z`} />
            <text x={node.width / 2 + 2} y={node.height / 2} textAnchor="middle" dominantBaseline="central">{node.displayName}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}

function FlowArrowMarker({ id, className }: { id: string; className: string }) {
  return (
    <marker id={id} className={`plant-flow-diagram-arrow ${className}`} viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto" markerUnits="userSpaceOnUse">
      <path d="M 0 0 L 6 3 L 0 6 Z" />
    </marker>
  );
}

function linkAccessibleLabel(link: PlantLiteFlowDiagramLink, truncated: boolean): string {
  const attribution = link.attribution === "parallel-route-total"
    ? `同端点 ${link.edgeIds.length} 条并行边合计，无法归属到单边`
    : "单边已配对证据";
  const scope = truncated ? "；轨迹已截断，仅代表已采集样本" : "";
  return `${link.fromNodeName}到${link.toNodeName}：已采集 ${link.capturedTransferCount} 次转移；${attribution}${scope}。`;
}
