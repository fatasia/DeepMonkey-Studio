import { useCallback, useEffect, useMemo, useState } from "react";
import { applyNodeChanges, Background, BackgroundVariant, Controls, MarkerType, MiniMap, Panel, ReactFlow,
  type Connection, type Edge, type NodeChange } from "@xyflow/react";
import { LayoutGrid, Trash2 } from "lucide-react";
import type { DataPipelineDefinition, DataPipelineNodeDiagnostic } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { pipelineConnectionIssue } from "./DataPipelineEditing";
import { DataPipelineGraphNode, type PipelineFlowNode } from "./DataPipelineGraphNode";
import { layoutWorkbenchGraph } from "./workbenchGraphLayout";
import { useWorkbenchGraphViewport } from "./useWorkbenchGraphViewport";
import "@xyflow/react/dist/style.css";

const NODE_TYPES = { pipeline: DataPipelineGraphNode };
export function DataPipelineCanvas({ locale, definition, selectedNodeId, diagnostics, onSelect, onChange, onError }: {
  locale: AppLocale; definition: DataPipelineDefinition; selectedNodeId?: string | undefined;
  diagnostics: Map<string, DataPipelineNodeDiagnostic>; onSelect: (id: string) => void;
  onChange: (definition: DataPipelineDefinition) => void; onError: (message: string) => void;
}) {
  const projected = useMemo<PipelineFlowNode[]>(() => definition.nodes.map(node => ({ id: node.id, type: "pipeline",
    position: node.position, selected: node.id === selectedNodeId, initialWidth: 208, initialHeight: 88,
    data: { definition: node, diagnostic: diagnostics.get(node.id) } })), [definition.nodes, selectedNodeId, diagnostics]);
  const [nodes, setNodes] = useState(projected);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const viewport = useWorkbenchGraphViewport(nodes, { width: 208, height: 88 });
  useEffect(() => { setNodes(projected); }, [projected]);
  useEffect(() => { if (!definition.edges.some(edge => edge.id === selectedEdgeId)) setSelectedEdgeId(undefined); }, [definition.edges, selectedEdgeId]);
  const edges = useMemo<Edge[]>(() => definition.edges.map(edge => ({ id: edge.id, source: edge.sourceNodeId,
    target: edge.targetNodeId, sourceHandle: "output", targetHandle: "input", selected: edge.id === selectedEdgeId,
    markerEnd: { type: MarkerType.ArrowClosed, color: "var(--text-muted)" }, interactionWidth: 24 })), [definition.edges, selectedEdgeId]);
  const onNodesChange = useCallback((changes: NodeChange<PipelineFlowNode>[]) => {
    setNodes(current => applyNodeChanges(changes.filter(change => change.type !== "remove"), current));
  }, []);
  function connect(connection: Connection, replacedEdgeId?: string) {
    const issue = pipelineConnectionIssue(definition, connection.source, connection.target, replacedEdgeId);
    if (issue) { onError(issue); return; }
    onError("");
    onChange({ ...definition, edges: [...definition.edges.filter(edge => edge.id !== replacedEdgeId),
      { id: replacedEdgeId ?? crypto.randomUUID(), sourceNodeId: connection.source, targetNodeId: connection.target }] });
  }
  function deleteEdges(ids: string[]) {
    onChange({ ...definition, edges: definition.edges.filter(edge => !ids.includes(edge.id)) });
  }
  return <div ref={viewport.container} className="pipeline-canvas" aria-label={tr(locale, "流水线画布", "Pipeline canvas")}>
    <ReactFlow<PipelineFlowNode, Edge> nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} onNodesChange={onNodesChange}
      proOptions={{ hideAttribution: true }}
      onInit={instance => { viewport.instance.current = instance; viewport.fit(projected); }}
      minZoom={.15} maxZoom={1.8} nodesDraggable nodesConnectable edgesReconnectable
      onNodeClick={(_, node) => { onSelect(node.id); setSelectedEdgeId(undefined); }}
      onNodeDragStop={(_, node) => onChange({ ...definition, nodes: definition.nodes.map(item =>
        item.id === node.id ? { ...item, position: node.position } : item) })}
      onEdgeClick={(_, edge) => setSelectedEdgeId(edge.id)} onPaneClick={() => setSelectedEdgeId(undefined)}
      onConnect={connection => connect(connection)} onReconnect={(edge, connection) => connect(connection, edge.id)}
      onEdgesDelete={(deleted: Edge[]) => deleteEdges(deleted.map(edge => edge.id))} deleteKeyCode={["Backspace", "Delete"]}
      onNodesDelete={() => undefined}>
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--line-subtle)" />
      <Controls showInteractive={false} position="bottom-right" />
      <MiniMap pannable zoomable style={{ width: 120, height: 70 }} nodeColor="var(--accent)" bgColor="var(--panel)" maskStrokeColor="var(--line)" maskColor="color-mix(in srgb, var(--surface-1) 75%, transparent)" />
      <Panel position="top-right"><div className="pipeline-canvas-actions">
        {selectedEdgeId && <button type="button" onClick={() => deleteEdges([selectedEdgeId])}><Trash2 size={13} />{tr(locale, "删除连线", "Delete connection")}</button>}
        <button type="button" onClick={() => {
          const positions = layoutWorkbenchGraph(definition.nodes.map(node => node.id),
            definition.edges.map(edge => ({ source: edge.sourceNodeId, target: edge.targetNodeId })), { width: 208, height: 88 });
          const next = definition.nodes.map(node => ({ ...node, position: positions.get(node.id)! }));
          onChange({ ...definition, nodes: next });
          viewport.fit(projected.map(node => ({ ...node, position: positions.get(node.id)! })));
        }}><LayoutGrid size={13} />{tr(locale, "整理布局", "Arrange")}</button>
      </div></Panel>
      <Panel position="bottom-left"><span className="pipeline-canvas-hint">{tr(locale,
        "拖动节点 · 从端口拉线 · 拖动连线端点改接", "Drag nodes · connect ports · drag edge endpoints to reconnect")}</span></Panel>
    </ReactFlow>
  </div>;
}
