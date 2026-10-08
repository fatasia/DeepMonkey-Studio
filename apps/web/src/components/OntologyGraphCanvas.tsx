import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyNodeChanges, Background, BackgroundVariant, Controls, Handle, MarkerType, MiniMap, Panel,
  Position, ReactFlow, type Connection, type Edge, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
import { Bell, Boxes, Database, LayoutGrid, MousePointer2, PencilLine, Zap } from "lucide-react";
import type { OntologyGraphEdge, OntologyGraphNodeKind, OntologyStatus } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { GRAPH_NODE_KIND_META, GRAPH_NODE_KIND_ORDER, GRAPH_STATUS_META } from "./ontologyGraphLogic";
import { graphEdgeLanes, graphEdgeSides } from "./workbenchGraphLayout";
import OntologyGraphEdgeView from "./OntologyGraphEdge";
import { useWorkbenchGraphViewport } from "./useWorkbenchGraphViewport";
import "@xyflow/react/dist/style.css";

export interface OntologyNodeData extends Record<string, unknown> {
  label: string; sub: string; kind: OntologyGraphNodeKind; statusText: string; status: OntologyStatus;
  highlighted: boolean; secondary: boolean; dimmed: boolean; clusterCount?: number;
  statusCounts?: Array<{ status: OntologyStatus; count: number }>;
  editable?: boolean;
}
export type OntologyFlowNode = Node<OntologyNodeData, "ontology">;
const KIND_ICONS = { object: Boxes, dataset: Database, action: Zap, event: Bell };
const SIDES = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };
const TYPE_COLORS = { object: "var(--accent)", dataset: "var(--info)", action: "var(--success)", event: "var(--danger)" };

const OntologyNodeCard = memo(function OntologyNodeCard({ data, selected }: NodeProps<OntologyFlowNode>) {
  const Icon = KIND_ICONS[data.kind];
  return <div className={["ontology-graph-node", GRAPH_NODE_KIND_META[data.kind].css,
    data.highlighted ? "is-highlighted" : "", data.secondary ? "is-secondary" : "",
    data.dimmed ? "is-dimmed" : "", selected ? "is-selected" : "", data.editable ? "is-editable" : ""].filter(Boolean).join(" ")}>
    {Object.entries(SIDES).map(([side, position]) => <Fragment key={side}>
      <Handle id={`source-${side}`} type="source" position={position} isConnectable={Boolean(data.editable)} className="ontology-port-source" />
      <Handle id={`target-${side}`} type="target" position={position} isConnectable={Boolean(data.editable)} className="ontology-port-target" />
    </Fragment>)}
    <header><span className="ontology-node-icon"><Icon size={16} /></span>
      <span title={data.label}>{data.label}</span>
      {data.clusterCount !== undefined && <b className="ontology-graph-node-cluster">{data.clusterCount}</b>}
    </header>
    <small title={data.sub}>{data.sub}</small>
    <footer><span className={`ontology-graph-node-status ${GRAPH_STATUS_META[data.status].css}`}>
      <i className="ontology-graph-node-shape" aria-hidden="true" />{data.statusText}
      {data.statusCounts && data.statusCounts.length > 1 && <small className="ontology-graph-node-statusmix"
        title={data.statusCounts.map(item => `${item.status}×${item.count}`).join(" / ")}> +{data.statusCounts.length - 1}</small>}
    </span></footer>
  </div>;
});
const NODE_TYPES = { ontology: OntologyNodeCard };
const EDGE_TYPES = { relation: OntologyGraphEdgeView };

export default function OntologyGraphCanvas({ nodes: projectedNodes, edges: relations, locale, selectedId, onSelectNode,
  onSelectEdge, onClear, highlightedEdges, secondaryEdges, resetVersion, editing, selectedEdgeId, onConnect, onEditEdge }: {
  nodes: OntologyFlowNode[]; edges: Array<OntologyGraphEdge & { aggregatedCount?: number }>;
  locale: AppLocale; selectedId?: string | undefined; onSelectNode: (id: string) => void; onSelectEdge: (id: string) => void;
  onClear: () => void; highlightedEdges: ReadonlySet<string>; secondaryEdges: boolean; resetVersion: number;
  editing: boolean; selectedEdgeId?: string | undefined;
  onConnect: (connection: Connection, relationKey?: string) => void; onEditEdge: (edge: OntologyGraphEdge) => void;
}) {
  const [nodes, setNodes] = useState(projectedNodes);
  const remembered = useRef(new Map<string, { x: number; y: number }>());
  const viewport = useWorkbenchGraphViewport(nodes, { width: 184, height: 84 });
  const instance = viewport.instance;
  const lastReset = useRef(resetVersion);
  const [tip, setTip] = useState<{ id: string; x: number; y: number }>();
  useEffect(() => {
    const reset = lastReset.current !== resetVersion;
    lastReset.current = resetVersion;
    if (reset) remembered.current.clear();
    setNodes(previous => {
      const previousById = new Map(previous.map(node => [node.id, node]));
      return projectedNodes.map(node => ({ ...node, selected: selectedId === node.id,
        position: reset ? node.position : remembered.current.get(node.id) ?? previousById.get(node.id)?.position ?? node.position }));
    });
    if (reset) viewport.fit(projectedNodes);
  }, [projectedNodes, selectedId, resetVersion]);
  useEffect(() => { setTip(undefined); }, [relations]);
  const onNodesChange = useCallback((changes: NodeChange<OntologyFlowNode>[]) => {
    for (const change of changes) if (change.type === "position" && change.position)
      remembered.current.set(change.id, change.position);
    setNodes(current => applyNodeChanges(changes.filter(change => change.type !== "remove"), current));
  }, []);
  const flowEdges = useMemo<Edge[]>(() => {
    const positions = new Map(nodes.map(node => [node.id, node.position]));
    const lanes = graphEdgeLanes(relations);
    return relations.map(edge => {
      const source = positions.get(edge.source), target = positions.get(edge.target);
      const self = edge.source === edge.target;
      const sides = self ? { sourceHandle: "right", targetHandle: "top" }
        : source && target ? graphEdgeSides(source, target) : { sourceHandle: "right", targetHandle: "left" };
      const highlight = highlightedEdges.has(edge.id);
      return { id: edge.id, source: edge.source, target: edge.target, type: "relation" as const,
        sourceHandle: `source-${sides.sourceHandle}`, targetHandle: `target-${sides.targetHandle}`,
        label: edge.aggregatedCount && edge.aggregatedCount > 1 ? `${edge.label} ×${edge.aggregatedCount}` : edge.label,
        data: { lane: lanes.get(edge.id) ?? 0, self }, selected: edge.id === selectedEdgeId,
        reconnectable: editing && edge.kind === "relation" && !edge.aggregatedCount,
        className: [`is-kind-${edge.kind}`, highlight ? "is-highlight" : "",
          !highlight && secondaryEdges ? "is-secondary" : ""].filter(Boolean).join(" "),
        ...(edge.direction === "directed" ? { markerEnd: { type: MarkerType.ArrowClosed,
          color: highlight ? "var(--accent)" : TYPE_COLORS[edge.kind === "relation" ? "object" : edge.kind === "data" ? "dataset" : edge.kind] } } : {}) };
    });
  }, [nodes, relations, highlightedEdges, secondaryEdges, selectedEdgeId, editing]);
  const tipEdge = relations.find(edge => edge.id === tip?.id);
  const selectedEdge = relations.find(edge => edge.id === selectedEdgeId);
  return <div className="ontology-graph-visual">
    <nav className="ontology-graph-navigation" aria-label={tr(locale, "图谱资产", "Graph assets")}>
      <header><strong>{tr(locale, "业务资产", "Business assets")}</strong><span>{projectedNodes.length}</span></header>
      {GRAPH_NODE_KIND_ORDER.map(kind => {
        const items = projectedNodes.filter(node => node.data.kind === kind);
        if (!items.length) return null;
        const Icon = KIND_ICONS[kind];
        return <section key={kind}><h4><Icon size={13} />{tr(locale, GRAPH_NODE_KIND_META[kind].zh, GRAPH_NODE_KIND_META[kind].en)}<small>{items.length}</small></h4>
          {items.map(node => <button type="button" key={node.id} className={selectedId === node.id ? "active" : ""}
            onClick={() => { onSelectNode(node.id); void instance.current?.fitView({ nodes: [{ id: node.id }], maxZoom: 1.1, duration: 0, padding: .6 }); }}>
            <span title={node.data.label}>{node.data.label}</span><small title={node.data.sub}>{node.data.sub}</small>
          </button>)}
        </section>;
      })}
    </nav>
    <div ref={viewport.container} className="ontology-graph-canvas">
      <ReactFlow<OntologyFlowNode, Edge> nodes={nodes} edges={flowEdges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
        proOptions={{ hideAttribution: true }}
        onInit={flow => { instance.current = flow; viewport.fit(projectedNodes); }} onNodesChange={onNodesChange}
        minZoom={.08} maxZoom={2}
        nodesConnectable={editing} edgesReconnectable={editing} deleteKeyCode={null} panOnDrag selectionOnDrag={false}
        isValidConnection={connection => nodes.some(node => node.id === connection.source && node.data.editable)
          && nodes.some(node => node.id === connection.target && node.data.editable)}
        onConnect={connection => onConnect(connection)}
        onReconnect={(edge, connection) => { const relation = relations.find(item => item.id === edge.id); if (relation?.kind === "relation") onConnect(connection, relation.relationKey ?? relation.label); }}
        onEdgeDoubleClick={(_, edge) => { const relation = relations.find(item => item.id === edge.id); if (editing && relation?.kind === "relation") onEditEdge(relation); }}
        onNodeClick={(_, node) => onSelectNode(node.id)} onEdgeClick={(_, edge) => onSelectEdge(edge.id)}
        onPaneClick={() => { onClear(); setTip(undefined); }}
        onEdgeMouseEnter={(event, edge) => setTip({ id: edge.id, x: event.clientX, y: event.clientY })}
        onEdgeMouseLeave={() => setTip(undefined)}>
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--line-subtle)" />
        <MiniMap pannable zoomable style={{ width: 130, height: 80 }} className="ontology-graph-minimap" bgColor="var(--panel)" maskStrokeColor="var(--line)" maskColor="color-mix(in srgb, var(--surface-1) 75%, transparent)"
          nodeColor={node => TYPE_COLORS[(node.data as OntologyNodeData).kind]} />
        <Controls showInteractive={false} position="bottom-right" />
        <Panel position="top-right"><div className="ontology-canvas-actions">
          {editing && selectedEdge?.kind === "relation" && <button type="button" onClick={() => onEditEdge(selectedEdge)}><PencilLine size={14} />{tr(locale, "编辑关系", "Edit relation")}</button>}
          <button type="button" onClick={() => {
          remembered.current.clear(); setNodes(projectedNodes);
          viewport.fit(projectedNodes);
        }}><LayoutGrid size={14} />{tr(locale, "整理布局", "Arrange")}</button></div></Panel>
        <Panel position="bottom-left"><span className="ontology-canvas-hint"><MousePointer2 size={12} />
          {editing ? tr(locale, "拖动对象端口连线 · 拖动边端点改接", "Connect object ports · drag edge endpoints to reconnect")
            : tr(locale, "拖动节点 · 滚轮缩放 · 拖动画布", "Drag nodes · scroll to zoom · pan canvas")}</span></Panel>
      </ReactFlow>
      {tip && tipEdge && <div className="ontology-graph-edge-tip" role="tooltip" style={{ left: tip.x + 12, top: tip.y + 12 }}>
        <strong>{tipEdge.label}</strong><small>{tipEdge.direction === "directed" ? tr(locale, "有向", "Directed") : tr(locale, "无向", "Undirected")}
          {tipEdge.cardinality ? ` · ${tipEdge.cardinality}` : ""} · {tipEdge.evidenceCount} {tr(locale, "证据", "evidence")}</small>
      </div>}
    </div>
  </div>;
}
