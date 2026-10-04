import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { MaterialGraphEdge, MaterialGraphNode } from "../materials/materialGraphModel";
import { translate as tr, type AppLocale } from "../i18n";

/**
 * 材质图画布(编辑器刀 7):轻量自绘 SVG 节点图,零新依赖。
 * 结构固定(底材质/层/遮罩/输出),连线是派生视图 —— 表达"层→遮罩→输出",
 * 拖拽只改本地位置态,不触发编译;点选节点由父级展示属性表单。
 */

export const NODE_WIDTH = 148;
export const NODE_HEIGHT = 46;
const PORT_RADIUS = 5;
const COLUMN_GAP = 88;
const ROW_GAP = 22;

export interface CanvasNodeLayout {
  node: MaterialGraphNode;
  x: number;
  y: number;
}

/** 确定性初始布局:base/输出顶行,层列自 90px 起(让出 base→输出主干线),遮罩在所属层左下(右端口仍指向层左端口,连线不回折)。 */
export function defaultNodeLayout(nodes: readonly MaterialGraphNode[]): Record<string, { x: number; y: number }> {
  const layout: Record<string, { x: number; y: number }> = {};
  let layerRow = 0;
  for (const node of nodes) {
    if (node.kind === "base") layout[node.id] = { x: 0, y: 10 };
    else if (node.kind === "output") layout[node.id] = { x: (NODE_WIDTH + COLUMN_GAP) * 2, y: 10 };
    else if (node.kind === "layer") {
      layout[node.id] = { x: NODE_WIDTH + COLUMN_GAP, y: 90 + layerRow * (NODE_HEIGHT + ROW_GAP + 8) };
      layerRow += 1;
    } else if (node.kind === "mask") {
      const owner = layout[node.layerId ?? ""];
      layout[node.id] = { x: NODE_WIDTH + COLUMN_GAP - NODE_WIDTH - 28, y: (owner?.y ?? 90) + NODE_HEIGHT + 12 };
    }
  }
  return layout;
}

function bezier(from: CanvasNodeLayout, to: CanvasNodeLayout): string {
  const x1 = from.x + NODE_WIDTH;
  const y1 = from.y + NODE_HEIGHT / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_HEIGHT / 2;
  const dx = Math.max(36, Math.abs(x2 - x1) * 0.5);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

interface Props {
  readonly locale: AppLocale;
  readonly nodes: readonly MaterialGraphNode[];
  readonly edges: readonly MaterialGraphEdge[];
  readonly positions: Record<string, { x: number; y: number }>;
  readonly selectedId: string | undefined;
  readonly disabled: boolean;
  readonly onSelect: (nodeId: string) => void;
  readonly onPositionsChange: (positions: Record<string, { x: number; y: number }>) => void;
}

const NODE_FILL: Record<MaterialGraphNode["kind"], string> = {
  output: "var(--accent-soft)",
  base: "var(--surface-3)",
  layer: "var(--surface-3)",
  mask: "var(--surface-2)",
};

const NODE_STROKE: Record<MaterialGraphNode["kind"], string> = {
  output: "var(--accent)",
  base: "var(--line-strong)",
  layer: "var(--line-strong)",
  mask: "var(--line)",
};

/** 画布视口按内容自适应;拖拽越界由 clamp 拉回。 */
export function MaterialGraphCanvas({ locale, nodes, edges, positions, selectedId, disabled, onSelect, onPositionsChange }: Props) {
  const [dragging, setDragging] = useState<{ id: string; offsetX: number; offsetY: number } | undefined>();
  const frameRef = useRef(0);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const layoutOf = useCallback((node: MaterialGraphNode): CanvasNodeLayout => {
    const fallback = defaultNodeLayout(nodes)[node.id] ?? { x: 0, y: 0 };
    const position = positions[node.id] ?? fallback;
    return { node, x: Math.max(0, position.x), y: Math.max(0, position.y) };
  }, [nodes, positions]);

  const layouts = nodes.map(layoutOf);
  const layoutById = new Map(layouts.map(item => [item.node.id, item]));
  const layerCount = nodes.filter(node => node.kind === "layer").length;
  const bounds = layouts.reduce(
    (acc, item) => ({ w: Math.max(acc.w, item.x + NODE_WIDTH), h: Math.max(acc.h, item.y + NODE_HEIGHT) }),
    { w: (NODE_WIDTH + COLUMN_GAP) * 2 + NODE_WIDTH, h: 10 + (layerCount ? 80 + layerCount * (NODE_HEIGHT + ROW_GAP + 8) + NODE_HEIGHT + 12 : 0) },
  );

  const startDrag = useCallback((event: ReactPointerEvent<SVGGElement>, nodeId: string) => {
    if (disabled) return;
    const point = svgPoint(svgRef.current, event);
    const current = layoutById.get(nodeId);
    if (!point || !current) return;
    onSelect(nodeId);
    setDragging({ id: nodeId, offsetX: point.x - current.x, offsetY: point.y - current.y });
    (event.target as Element).setPointerCapture?.(event.pointerId);
  }, [disabled, layoutById, onSelect]);

  const moveDrag = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragging) return;
    const point = svgPoint(svgRef.current, event);
    if (!point) return;
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const next = {
        ...positions,
        [dragging.id]: {
          x: Math.max(0, Math.round(point.x - dragging.offsetX)),
          y: Math.max(0, Math.round(point.y - dragging.offsetY)),
        },
      };
      onPositionsChange(next);
    });
  }, [dragging, onPositionsChange, positions]);

  const endDrag = useCallback(() => {
    if (frameRef.current) { cancelAnimationFrame(frameRef.current); frameRef.current = 0; }
    setDragging(undefined);
  }, []);

  return (
    <svg
      ref={svgRef}
      className="material-graph-canvas"
      role="application"
      aria-label={tr(locale, "材质图节点画布", "Material graph node canvas")}
      viewBox={`0 0 ${Math.max(bounds.w, 320)} ${Math.max(bounds.h, 96)}`}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
    >
      {edges.map(edge => {
        const from = layoutById.get(edge.from);
        const to = layoutById.get(edge.to);
        if (!from || !to) return null;
        return <path key={edge.id} className="material-graph-edge" d={bezier(from, to)} />;
      })}
      {layouts.map(item => {
        const selected = selectedId === item.node.id;
        return (
          <g
            key={item.node.id}
            className={`material-graph-node${selected ? " selected" : ""}${disabled ? " disabled" : ""}`}
            transform={`translate(${item.x}, ${item.y})`}
            onPointerDown={event => startDrag(event, item.node.id)}
            data-node-kind={item.node.kind}
            data-node-id={item.node.id}
          >
            <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx="7" fill={NODE_FILL[item.node.kind]} stroke={NODE_STROKE[item.node.kind]} strokeWidth={selected ? 2 : 1} />
            <text className="material-graph-node-title" x="10" y="19">{item.node.title}</text>
            <text className="material-graph-node-subtitle" x="10" y="35">{item.node.subtitle}</text>
            {item.node.kind !== "output" && <circle className="material-graph-port" cx={NODE_WIDTH} cy={NODE_HEIGHT / 2} r={PORT_RADIUS} />}
            {item.node.kind !== "base" && item.node.kind !== "mask" && <circle className="material-graph-port" cx="0" cy={NODE_HEIGHT / 2} r={PORT_RADIUS} />}
          </g>
        );
      })}
    </svg>
  );
}

/** SVG 用户坐标换算(拖拽命中);svg 缺失/非法矩阵返回 undefined。 */
function svgPoint(svg: SVGSVGElement | null, event: { clientX: number; clientY: number }): { x: number; y: number } | undefined {
  if (!svg) return undefined;
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height) return undefined;
  const viewBox = svg.viewBox.baseVal;
  const scale = viewBox.width && viewBox.height
    ? { x: viewBox.width / rect.width, y: viewBox.height / rect.height }
    : { x: 1, y: 1 };
  return { x: (event.clientX - rect.left) * scale.x, y: (event.clientY - rect.top) * scale.y };
}
