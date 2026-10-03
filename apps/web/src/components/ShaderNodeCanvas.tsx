import { useCallback, useMemo, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  applyNodeChanges,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ShaderGraphAssetV1 } from "@bim-studio/deep-engine/shader-graph";
import { translate as tr, type AppLocale } from "../i18n";
import { validateShaderGraphAsset } from "@bim-studio/deep-engine/shader-graph";
import {
  addNode, canvasEdges, canvasNodes, connect, disconnect,
  removeNode, updateNodeConfig, type CanvasNodePosition,
} from "./shaderNodeCanvasModel.js";

interface Props {
  readonly locale: AppLocale;
  readonly asset: ShaderGraphAssetV1;
  readonly onAssetChange: (asset: ShaderGraphAssetV1) => void;
  readonly disabled?: boolean;
}

/** 材质节点图画布(ReactFlow 薄壳;编辑语义全在 shaderNodeCanvasModel)。M1 只编辑 fragment stage。 */
export function ShaderNodeCanvas({ locale, asset, onAssetChange, disabled }: Props) {
  const [positions, setPositions] = useState<Record<string, CanvasNodePosition>>({});
  const [selectedId, setSelectedId] = useState<string | undefined>();

  const nodes = useMemo<Node[]>(() => canvasNodes(asset).map((node) => ({
    id: node.id,
    position: positions[node.id] ?? {
      x: 40 + (Object.keys(positions).length % 6) * 190,
      y: 30 + Math.floor(Object.keys(positions).length / 6) * 110,
    },
    data: { label: `${node.label}\n[${node.type}]` },
  })), [asset, positions]);

  const edges = useMemo<Edge[]>(() => canvasEdges(asset).map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    targetHandle: edge.targetHandle,
    animated: false,
  })), [asset]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    if (disabled) return;
    const moved = changes.filter((c): c is Extract<NodeChange, { type: "position" }> => c.type === "position" && c.dragging === true);
    if (moved.length === 0) return;
    setPositions((prev) => {
      const next = { ...prev };
      for (const change of moved) { if (change.position) next[change.id] = change.position; }
      return next;
    });
  }, []);

  const onConnect = useCallback((connection: { source: string; target: string; targetHandle: string | null }) => {
    if (disabled) return;
    const input = Number((connection.targetHandle ?? "in-0").replace("in-", "")) || 0;
    onAssetChange(connect(asset, connection.source, connection.target, input));
  }, [asset, onAssetChange, disabled]);

  const selectedNode = selectedId
    ? canvasNodes(asset).find(node => node.id === selectedId)
    : undefined;

  const updateSelectedConfig = useCallback((config: Readonly<Record<string, unknown>>) => {
    if (selectedId) onAssetChange(updateNodeConfig(asset, selectedId, config));
  }, [asset, onAssetChange, selectedId]);

  const removeSelected = useCallback(() => {
    if (selectedId) onAssetChange(removeNode(asset, selectedId));
    setSelectedId(undefined);
  }, [asset, onAssetChange, selectedId]);

  const diagnostics = useMemo(() => validateShaderGraphAsset(asset), [asset]);
  const errorText = diagnostics.diagnostics
    .filter(d => d.severity === "error")
    .map(d => d.message)
    .join("；") || tr(locale, "图有效", "Graph is valid");

  return (
    <div className="shader-node-canvas" role="application" aria-label={tr(locale, "材质节点图", "Material node graph")}>
      <div className="shader-node-canvas-toolbar">
        <select
          aria-label={tr(locale, "添加节点", "Add node")}
          disabled={disabled}
          value=""
          onChange={(event) => {
            if (!event.target.value) return;
            const result = addNode(asset, event.target.value);
            onAssetChange(result.asset);
            setSelectedId(result.nodeId);
          }}
        >
          <option value="">{tr(locale, "添加节点…", "Add node…")}</option>
          <option value="literal">{tr(locale, "常量", "Literal")}</option>
          <option value="add">{tr(locale, "加法", "Add")}</option>
          <option value="subtract">{tr(locale, "减法", "Subtract")}</option>
          <option value="multiply">{tr(locale, "乘法", "Multiply")}</option>
          <option value="divide">{tr(locale, "除法", "Divide")}</option>
          <option value="min">{tr(locale, "最小值", "Min")}</option>
          <option value="max">{tr(locale, "最大值", "Max")}</option>
          <option value="property">{tr(locale, "材质属性", "Property")}</option>
        </select>
        <button
          type="button"
          disabled={disabled || !selectedId}
          onClick={removeSelected}
        >
          {tr(locale, "删除选中", "Delete selected")}
        </button>
        <span className={`shader-node-canvas-status ${diagnostics.valid ? "ok" : "error"}`} role="status">
          {errorText}
        </span>
      </div>
      <div className="shader-node-canvas-flow">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          onNodeClick={(_, node) => setSelectedId(node.id)}
          onPaneClick={() => setSelectedId(undefined)}
          fitView
          nodesDraggable={!disabled}
          nodesConnectable={!disabled}
          elementsSelectable={!disabled}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {selectedNode && !disabled && (
        <div className="shader-node-canvas-props">
          <strong>{selectedNode.label}</strong>
          {selectedNode.category === "input" && selectedNode.id.startsWith("literal") && (
            <label>
              {tr(locale, "常量值", "Value")}
              <input
                type="number"
                step="0.05"
                value={Number(selectedNode.config?.value ?? 0)}
                onChange={(event) => updateSelectedConfig({ value: Number(event.target.value) })}
              />
            </label>
          )}
          {selectedNode.id.startsWith("property") && (
            <label>
              {tr(locale, "属性名", "Property name")}
              <input
                type="text"
                value={String(selectedNode.config?.name ?? "")}
                onChange={(event) => updateSelectedConfig({ name: event.target.value })}
              />
            </label>
          )}
        </div>
      )}
    </div>
  );
}
