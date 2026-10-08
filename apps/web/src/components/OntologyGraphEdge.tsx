import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from "@xyflow/react";

type RelationEdge = Edge<{ lane: number; self: boolean }, "relation">;

export default function OntologyGraphEdge(props: EdgeProps<RelationEdge>) {
  const { id, sourceX: sx, sourceY: sy, targetX: tx, targetY: ty, data, label, markerEnd, selected } = props;
  let path: string, x: number, y: number;
  if (data?.self) {
    const lift = 66 + Math.abs(data.lane);
    path = `M ${sx} ${sy} C ${sx + lift} ${sy - lift}, ${tx - lift} ${ty - lift}, ${tx} ${ty}`;
    x = (sx + tx) / 2; y = (sy + ty) / 2 - lift * .75;
  } else if (data?.lane) {
    const dx = tx - sx, dy = ty - sy, length = Math.hypot(dx, dy) || 1;
    const cx = (sx + tx) / 2 - dy / length * data.lane * 2;
    const cy = (sy + ty) / 2 + dx / length * data.lane * 2;
    path = `M ${sx} ${sy} Q ${cx} ${cy} ${tx} ${ty}`;
    x = (sx + tx + 2 * cx) / 4; y = (sy + ty + 2 * cy) / 4;
  } else {
    [path, x, y] = getBezierPath({ ...props, curvature: .18 });
  }
  return <>
    <BaseEdge id={id} path={path} {...(markerEnd ? { markerEnd } : {})} interactionWidth={20} />
    {label && <EdgeLabelRenderer>
      <span className={`ontology-relation-label nodrag nopan ${selected ? "is-selected" : ""}`}
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }} title={String(label)}>
        {label}
      </span>
    </EdgeLabelRenderer>}
  </>;
}
