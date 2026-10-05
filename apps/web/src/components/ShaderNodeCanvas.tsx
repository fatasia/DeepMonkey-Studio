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
import { lowerShaderGraphAsset, validateShaderGraphAsset } from "@bim-studio/deep-engine/shader-graph";
import { translate as tr, type AppLocale } from "../i18n";
import {
  SURFACE_FIELD_KEYS, addNode, bindSurfaceField, canvasEdges, canvasNodes, connect, disconnect,
  removeNode, surfaceBindings, updateNodeConfig, type CanvasNodePosition, type SurfaceFieldKey,
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
  const [bindField, setBindField] = useState<SurfaceFieldKey>("baseColor");

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
  // 降级检查 = 图 → 既有 WGSL 编译器 IR 的确定性检查(非管线编译;节点输入未补全时
  // 引擎 tuple 抛错,如实报告为「待补全」,不伪报编译通过)。
  const loweringNote = useMemo(() => {
    if (!diagnostics.valid) return "";
    try {
      const result = lowerShaderGraphAsset(asset);
      if (result.success) {
        const nodeCount = result.stages?.[0]?.nodes.length ?? 0;
        return tr(locale, ` · 降级通过(${nodeCount} 节点)`, ` · lowering ok (${nodeCount} nodes)`);
      }
      return tr(locale, ` · 降级未通过:${result.diagnostics[0]?.message ?? ""}`, ` · lowering failed: ${result.diagnostics[0]?.message ?? ""}`);
    } catch (error) {
      return tr(locale, ` · 输入待补全(${error instanceof Error ? error.message : "lowering error"})`,
        ` · inputs incomplete (${error instanceof Error ? error.message : "lowering error"})`);
    }
  }, [asset, diagnostics.valid, locale]);
  const errorText = diagnostics.diagnostics
    .filter(d => d.severity === "error")
    .map(d => d.message)
    .join("；") || tr(locale, "图有效", "Graph is valid");
  const bindings = useMemo(() => surfaceBindings(asset), [asset]);

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
          {errorText}{loweringNote}
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
          <div className="shader-node-canvas-surface">
            <strong>{tr(locale, "表面输出绑定", "Surface outputs")}</strong>
            <ul className="shader-node-canvas-bindings">
              {Object.entries(bindings).map(([field, nodeId]) => (
                <li key={field}>
                  <span>{field}</span>
                  <code>{nodeId}</code>
                  <button type="button" disabled={disabled}
                    aria-label={tr(locale, `解绑 ${field}`, `Unbind ${field}`)}
                    title={tr(locale, "解绑", "Unbind")}
                    onClick={() => onAssetChange(bindSurfaceField(asset, field as SurfaceFieldKey, undefined))}>
                    ×
                  </button>
                </li>
              ))}
              {Object.keys(bindings).length === 0 && (
                <li className="empty">{tr(locale, "未绑定——图不写任何表面参数", "Nothing bound — the graph writes no surface fields")}</li>
              )}
            </ul>
            <div className="shader-node-canvas-bindrow">
              <select aria-label={tr(locale, "选择表面字段", "Surface field")} disabled={disabled}
                value={bindField}
                onChange={(event) => setBindField(event.currentTarget.value as SurfaceFieldKey)}>
                {SURFACE_FIELD_KEYS.map((field) => (
                  <option key={field} value={field}>{field}</option>
                ))}
              </select>
              <button type="button" disabled={disabled}
                onClick={() => onAssetChange(bindSurfaceField(asset, bindField, selectedId))}>
                {tr(locale, "绑定选中节点", "Bind selected node")}
              </button>
            </div>
            <small>
              {tr(locale,
                "图是草稿面:实时校验+降级检查,随材质槽本地持久;绑定到材质的权威路径仍是「源码」页签的 DeepSL 绑定。",
                "The graph is a draft surface: validated and lowered live, persisted locally per material slot; the authoritative material binding remains the DeepSL source tab.")}
            </small>
          </div>
        </div>
      )}
    </div>
  );
}
