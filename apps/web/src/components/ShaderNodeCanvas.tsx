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
import { shaderGraphNodeRegistry } from "@bim-studio/deep-engine/shader-graph";
import { translate as tr, type AppLocale } from "../i18n";
import {
  SURFACE_FIELD_KEYS, addNode, bindSurfaceField, canvasEdges, canvasNodes, connect, disconnect,
  diagnosticEdgeKeys, diagnosticNodeIds, graphDiagnostics, removeNode, surfaceBindings,
  updateNodeConfig, type CanvasGraphDiagnostic, type CanvasNodePosition, type SurfaceFieldKey,
} from "./shaderNodeCanvasModel.js";

interface Props {
  readonly locale: AppLocale;
  readonly asset: ShaderGraphAssetV1;
  readonly onAssetChange: (asset: ShaderGraphAssetV1) => void;
  readonly disabled?: boolean;
}

/** 节点双语名(键 = 注册表 op;未收录回退引擎 label)。 */
const NODE_LABELS: Readonly<Record<string, readonly [string, string]>> = {
  literal: ["常量", "Literal"], property: ["材质属性", "Property"], attribute: ["顶点属性", "Attribute"],
  varying: ["插值变量", "Varying"], add: ["加法", "Add"], subtract: ["减法", "Subtract"],
  multiply: ["乘法", "Multiply"], divide: ["除法", "Divide"], min: ["最小值", "Min"],
  max: ["最大值", "Max"], pow: ["幂", "Pow"], dot: ["点积", "Dot"], normalize: ["归一化", "Normalize"],
  negate: ["取反", "Negate"], saturate: ["饱和", "Saturate"], "one-minus": ["一减", "One Minus"],
  abs: ["绝对值", "Abs"], floor: ["向下取整", "Floor"], fract: ["小数部分", "Fract"],
  "compose-vec4": ["组装 Vec4", "Compose Vec4"], swizzle: ["重排分量", "Swizzle"],
  select: ["条件选择", "Select"], clamp: ["钳制", "Clamp"], mix: ["插值", "Mix"],
  smoothstep: ["平滑阶梯", "Smoothstep"], cross: ["叉积", "Cross"], scale: ["缩放", "Scale"],
  "transform-direction": ["变换方向", "Transform Direction"],
  "transform-position": ["变换位置", "Transform Position"],
  "texture-sample": ["纹理采样", "Texture Sample"], "pbr-frame-view": ["PBR 帧", "PBR Frame View"],
};
const CATEGORY_LABELS: Readonly<Record<string, readonly [string, string]>> = {
  input: ["输入", "Input"], math: ["数学", "Math"], geometry: ["几何", "Geometry"],
  texture: ["纹理", "Texture"], stage: ["阶段", "Stage"], surface: ["表面", "Surface"],
};
const CATEGORY_ORDER = ["input", "math", "geometry", "texture", "stage", "surface"] as const;

/** 调色板按注册表分组(注册表扩面即画布可见,无需改组件)。 */
function paletteGroups(locale: AppLocale): Array<{ category: string; label: string; ops: string[] }> {
  const groups: Record<string, string[]> = {};
  for (const meta of shaderGraphNodeRegistry()) (groups[meta.category] ??= []).push(meta.op);
  return CATEGORY_ORDER.filter(category => groups[category]?.length).map(category => ({
    category,
    label: tr(locale, CATEGORY_LABELS[category]?.[0] ?? category, CATEGORY_LABELS[category]?.[1] ?? category),
    ops: groups[category]!,
  }));
}

/** 材质节点图画布(ReactFlow 薄壳;编辑语义全在 shaderNodeCanvasModel)。M1 只编辑 fragment stage。 */
export function ShaderNodeCanvas({ locale, asset, onAssetChange, disabled }: Props) {
  const [positions, setPositions] = useState<Record<string, CanvasNodePosition>>({});
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [bindField, setBindField] = useState<SurfaceFieldKey>("baseColor");

  const issues = useMemo(() => graphDiagnostics(asset), [asset]);
  const errorNodeIds = useMemo(() => diagnosticNodeIds(issues), [issues]);
  const errorEdgeKeys = useMemo(() => diagnosticEdgeKeys(issues), [issues]);
  const nodeLabel = useCallback((op: string, fallback: string) => {
    const pair = NODE_LABELS[op];
    return pair ? tr(locale, pair[0], pair[1]) : fallback;
  }, [locale]);

  const nodes = useMemo<Node[]>(() => canvasNodes(asset).map((node) => ({
    id: node.id,
    position: positions[node.id] ?? {
      x: 40 + (Object.keys(positions).length % 6) * 190,
      y: 30 + Math.floor(Object.keys(positions).length / 6) * 110,
    },
    ...(errorNodeIds.has(node.id) ? { className: "shader-node-invalid" } : {}),
    data: { label: `${nodeLabel(node.op, node.label)}\n[${node.type}]` },
  })), [asset, positions, errorNodeIds, nodeLabel]);

  const edges = useMemo<Edge[]>(() => canvasEdges(asset).map((edge) => {
    const invalid = errorEdgeKeys.has(edge.key);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      targetHandle: edge.targetHandle,
      animated: invalid,
      ...(invalid ? { style: { stroke: "#e5484d" } } : {}),
    };
  }), [asset, errorEdgeKeys]);

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

  const errorCount = issues.filter(issue => issue.severity === "error").length;
  const warningCount = issues.length - errorCount;
  const statusText = issues.length === 0
    ? tr(locale, "图有效", "Graph is valid")
    : tr(locale, `${errorCount} 错误 · ${warningCount} 警告`, `${errorCount} errors · ${warningCount} warnings`);
  const describeIssue = useCallback((issue: CanvasGraphDiagnostic) => {
    if (issue.severity === "warning") {
      return tr(locale, `输入待连接:${issue.message}`, `Input pending: ${issue.message}`);
    }
    return issue.message;
  }, [locale]);
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
          {paletteGroups(locale).map(group => (
            <optgroup key={group.category} label={group.label}>
              {group.ops.map(op => <option key={op} value={op}>{nodeLabel(op, op)}</option>)}
            </optgroup>
          ))}
        </select>
        <button
          type="button"
          disabled={disabled || !selectedId}
          onClick={removeSelected}
        >
          {tr(locale, "删除选中", "Delete selected")}
        </button>
        <span className={`shader-node-canvas-status ${errorCount === 0 ? "ok" : "error"}`} role="status">
          {statusText}
        </span>
      </div>
      {issues.length > 0 && (
        <ul className="shader-node-canvas-issues" role="alert">
          {issues.map((issue, index) => (
            <li key={`${issue.code}-${issue.path}-${index}`} className={issue.severity}>
              <span className="shader-node-canvas-issue-severity">
                {issue.severity === "error" ? tr(locale, "错误", "Error") : tr(locale, "警告", "Warning")}
              </span>
              <span className="shader-node-canvas-issue-text">{describeIssue(issue)}</span>
              {issue.nodeId && (
                <button type="button" className="shader-node-canvas-issue-locate"
                  onClick={() => setSelectedId(issue.nodeId)}>
                  {tr(locale, `定位 ${issue.nodeId}`, `Locate ${issue.nodeId}`)}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
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
          <strong>{nodeLabel(selectedNode.op, selectedNode.label)}</strong>
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
