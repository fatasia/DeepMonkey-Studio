import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from "react";
import { ArrowDownAZ, ArrowLeft, ArrowRight, Box, Braces, Calculator, CheckCircle2, Code2, Database, Filter, Gauge, GitBranch, GripVertical, ListEnd, LoaderCircle, Play, Plus, Save, Trash2, XCircle } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { DataDatasetRecord, DataFieldType, DataPipelineDefinition, DataPipelineNode, DataPipelineNodeDiagnostic, DataPipelinePreview } from "@bim-studio/contracts";
import { api } from "../api";

type TransformNodeType = "filter" | "formula" | "script" | "sort" | "limit";

export function DataPipelineStudio({ locale, projectId, datasets, onError }: { locale: AppLocale; projectId: string; datasets: DataDatasetRecord[]; onError: (message: string) => void }) {
  const [pipelines, setPipelines] = useState<DataPipelineDefinition[]>([]);
  const [draft, setDraft] = useState<DataPipelineDefinition>();
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [preview, setPreview] = useState<DataPipelinePreview>();
  const [busy, setBusy] = useState(false);
  const [draggedNodeId, setDraggedNodeId] = useState<string>();

  async function load(preferredId?: string) {
    setBusy(true);
    try {
      const next = await api.listDataPipelines(projectId);
      setPipelines(next);
      const selected = next.find((item) => item.id === preferredId) ?? next[0];
      setDraft(selected ? structuredClone(selected) : undefined);
      setSelectedNodeId(selected?.nodes[0]?.id);
      setPreview(undefined);
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void load(); }, [projectId]);

  function createPipeline() {
    const dataset = datasets[0];
    if (!dataset) { onError(tr(locale, "请先创建数据集，再编排逻辑。", "Create a dataset before building a pipeline.")); return; }
    const now = new Date().toISOString();
    const sourceId = crypto.randomUUID();
    const outputId = crypto.randomUUID();
    const next: DataPipelineDefinition = {
      id: crypto.randomUUID(), projectId, name: tr(locale, "新数据流水线", "New data pipeline"), createdAt: now, updatedAt: now,
      nodes: [
        { id: sourceId, type: "source", name: dataset.name, datasetId: dataset.id, position: { x: 0, y: 0 } },
        { id: outputId, type: "output", name: tr(locale, "数据产品", "Data product"), position: { x: 240, y: 0 } }
      ],
      edges: [{ id: crypto.randomUUID(), sourceNodeId: sourceId, targetNodeId: outputId }]
    };
    setDraft(next); setSelectedNodeId(sourceId); setPreview(undefined);
  }

  async function save(runAfter = false) {
    if (!draft) return;
    setBusy(true); onError("");
    try {
      const normalized = normalizeLinearPipeline(draft);
      const saved = await api.saveDataPipeline(projectId, normalized);
      const nextPipelines = [...pipelines.filter((item) => item.id !== saved.id), saved];
      setPipelines(nextPipelines);
      setDraft(structuredClone(saved));
      if (runAfter) {
        const result = await api.previewDataPipeline(projectId, saved.id);
        setPreview(result);
        if (result.failedNodeId) setSelectedNodeId(result.failedNodeId);
        if (result.error) onError(result.error);
      }
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function removePipeline(pipeline: DataPipelineDefinition) {
    if (!window.confirm(tr(locale, `删除流水线“${pipeline.name}”？`, `Delete pipeline “${pipeline.name}”?`))) return;
    try { await api.deleteDataPipeline(projectId, pipeline.id); await load(); }
    catch (reason) { onError(errorMessage(reason)); }
  }

  function addNode(type: TransformNodeType) {
    if (!draft) return;
    const node = createTransformNode(type, locale);
    const outputIndex = draft.nodes.findIndex((item) => item.type === "output");
    const nodes = [...draft.nodes];
    nodes.splice(outputIndex < 0 ? nodes.length : outputIndex, 0, node);
    setDraft(normalizeLinearPipeline({ ...draft, nodes }));
    setSelectedNodeId(node.id); setPreview(undefined);
  }

  function updateNode(updater: (node: DataPipelineNode) => DataPipelineNode) {
    if (!draft || !selectedNodeId) return;
    setDraft({ ...draft, nodes: draft.nodes.map((node) => node.id === selectedNodeId ? updater(node) : node) });
    setPreview(undefined);
  }

  function removeNode(nodeId: string) {
    if (!draft) return;
    const node = draft.nodes.find((item) => item.id === nodeId);
    if (!node || node.type === "source" || node.type === "output") return;
    const nodes = draft.nodes.filter((item) => item.id !== nodeId);
    setDraft(normalizeLinearPipeline({ ...draft, nodes }));
    setSelectedNodeId(nodes[Math.max(0, draft.nodes.findIndex((item) => item.id === nodeId) - 1)]?.id);
    setPreview(undefined);
  }

  function moveNode(nodeId: string, offset: -1 | 1) {
    if (!draft) return;
    const index = draft.nodes.findIndex((item) => item.id === nodeId);
    const target = index + offset;
    if (index <= 0 || target <= 0 || target >= draft.nodes.length - 1) return;
    const nodes = [...draft.nodes];
    [nodes[index], nodes[target]] = [nodes[target]!, nodes[index]!];
    setDraft(normalizeLinearPipeline({ ...draft, nodes })); setPreview(undefined);
  }

  function dropNode(event: DragEvent, targetId: string) {
    event.preventDefault();
    if (!draft || !draggedNodeId || draggedNodeId === targetId) return;
    const moving = draft.nodes.find((node) => node.id === draggedNodeId);
    const target = draft.nodes.find((node) => node.id === targetId);
    if (!moving || moving.type === "source" || moving.type === "output" || !target || target.type === "source") return;
    const nodes = draft.nodes.filter((node) => node.id !== draggedNodeId);
    nodes.splice(nodes.findIndex((node) => node.id === targetId), 0, moving);
    setDraft(normalizeLinearPipeline({ ...draft, nodes })); setDraggedNodeId(undefined); setPreview(undefined);
  }

  const selectedNode = draft?.nodes.find((node) => node.id === selectedNodeId);
  const diagnostics = useMemo(() => new Map(preview?.diagnostics.map((item) => [item.nodeId, item]) ?? []), [preview]);

  return <div className="pipeline-studio">
    <aside className="pipeline-library">
      <header><span><strong>{tr(locale, "逻辑流水线", "Logic pipelines")}</strong><small>{pipelines.length} {tr(locale, "个流程", "flows")}</small></span><button disabled={!datasets.length} onClick={createPipeline}><Plus size={14} />{tr(locale, "新建", "New")}</button></header>
      <div className="pipeline-list">{pipelines.map((pipeline) => <article className={draft?.id === pipeline.id ? "active" : ""} key={pipeline.id}><button onClick={() => { setDraft(structuredClone(pipeline)); setSelectedNodeId(pipeline.nodes[0]?.id); setPreview(undefined); }}><GitBranch size={16} /><span><strong>{pipeline.name}</strong><small>{pipeline.nodes.length} {tr(locale, "个节点", "nodes")}</small></span></button><button className="icon danger" title={tr(locale, "删除", "Delete")} onClick={() => void removePipeline(pipeline)}><Trash2 size={13} /></button></article>)}</div>
      {!pipelines.length && <div className="pipeline-empty"><GitBranch size={24} /><strong>{tr(locale, "从一条轻量流程开始", "Start with a lightweight flow")}</strong><span>{tr(locale, "选数据集，添加处理节点，立即查看每一步结果。", "Choose a dataset, add transforms, and inspect every step.")}</span></div>}
    </aside>
    <section className="pipeline-workspace">
      {!draft ? <div className="pipeline-blank"><GitBranch size={32} /><strong>{tr(locale, "可视化编排数据逻辑", "Build data logic visually")}</strong><span>{datasets.length ? tr(locale, "创建流水线后，用节点完成过滤、计算、脚本、排序与输出。", "Create a pipeline for filtering, calculations, scripts, sorting and output.") : tr(locale, "先在数据准备中创建一个数据集。", "Create a dataset in Data preparation first.")}</span><button disabled={!datasets.length} onClick={createPipeline}><Plus size={14} />{tr(locale, "创建流水线", "Create pipeline")}</button></div> : <>
        <header className="pipeline-toolbar"><input aria-label={tr(locale, "流水线名称", "Pipeline name")} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /><div className="pipeline-add-nodes"><span>{tr(locale, "添加处理", "Add transform")}</span><NodeAddButton icon={<Filter />} label={tr(locale, "过滤", "Filter")} onClick={() => addNode("filter")} /><NodeAddButton icon={<Calculator />} label={tr(locale, "公式", "Formula")} onClick={() => addNode("formula")} /><NodeAddButton icon={<Code2 />} label={tr(locale, "脚本", "Script")} onClick={() => addNode("script")} /><NodeAddButton icon={<ArrowDownAZ />} label={tr(locale, "排序", "Sort")} onClick={() => addNode("sort")} /><NodeAddButton icon={<ListEnd />} label={tr(locale, "限量", "Limit")} onClick={() => addNode("limit")} /></div><div className="pipeline-actions"><button disabled={busy || !draft.name.trim()} onClick={() => void save()}><Save size={14} />{tr(locale, "保存", "Save")}</button><button className="primary" disabled={busy || !draft.name.trim()} onClick={() => void save(true)}>{busy ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}{tr(locale, "保存并运行", "Save & run")}</button></div></header>
        <div className="pipeline-canvas">{draft.nodes.map((node, index) => <div className="pipeline-node-wrap" key={node.id}>{index > 0 && <i className="pipeline-edge"><span /></i>}<PipelineNodeCard node={node} selected={node.id === selectedNodeId} diagnostic={diagnostics.get(node.id)} draggable={node.type !== "source" && node.type !== "output"} onDragStart={() => setDraggedNodeId(node.id)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropNode(event, node.id)} onSelect={() => setSelectedNodeId(node.id)} /></div>)}</div>
        <div className="pipeline-lower"><NodeInspector locale={locale} node={selectedNode} datasets={datasets} onChange={updateNode} onRemove={removeNode} onMove={moveNode} /><PipelineResult locale={locale} preview={preview} selectedNodeId={selectedNodeId} /></div>
      </>}
    </section>
  </div>;
}

function PipelineNodeCard({ node, selected, diagnostic, draggable, onDragStart, onDragOver, onDrop, onSelect }: { node: DataPipelineNode; selected: boolean; diagnostic?: DataPipelineNodeDiagnostic | undefined; draggable: boolean; onDragStart: () => void; onDragOver: (event: DragEvent) => void; onDrop: (event: DragEvent) => void; onSelect: () => void }) {
  return <button draggable={draggable} onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop} className={`pipeline-node ${selected ? "selected" : ""} ${diagnostic?.status ?? ""}`} onClick={onSelect}><span className="pipeline-node-icon">{draggable && <GripVertical size={11} />}{nodeIcon(node.type)}</span><span><small>{nodeTypeLabel(node.type)}</small><strong>{node.name}</strong><em>{nodeSummary(node)}</em></span>{diagnostic && <b title={`${diagnostic.inputRows} → ${diagnostic.outputRows} · ${diagnostic.durationMs.toFixed(1)}ms`}>{diagnostic.status === "success" ? <CheckCircle2 size={14} /> : <XCircle size={14} />}</b>}</button>;
}

function NodeInspector({ locale, node, datasets, onChange, onRemove, onMove }: { locale: AppLocale; node?: DataPipelineNode | undefined; datasets: DataDatasetRecord[]; onChange: (updater: (node: DataPipelineNode) => DataPipelineNode) => void; onRemove: (id: string) => void; onMove: (id: string, offset: -1 | 1) => void }) {
  if (!node) return <section className="pipeline-inspector pipeline-panel-empty">{tr(locale, "选择节点查看配置", "Select a node to inspect")}</section>;
  const mutate = <T extends DataPipelineNode>(patch: Partial<T>) => onChange((current) => ({ ...current, ...patch } as DataPipelineNode));
  return <section className="pipeline-inspector"><header><span><strong>{tr(locale, "节点配置", "Node settings")}</strong><small>{nodeTypeLabel(node.type)}</small></span><div>{node.type !== "source" && node.type !== "output" && <><button title={tr(locale, "向前移动", "Move left")} onClick={() => onMove(node.id, -1)}><ArrowLeft size={13} /></button><button title={tr(locale, "向后移动", "Move right")} onClick={() => onMove(node.id, 1)}><ArrowRight size={13} /></button><button className="danger" title={tr(locale, "删除节点", "Delete node")} onClick={() => onRemove(node.id)}><Trash2 size={13} /></button></>}</div></header><div className="pipeline-inspector-body"><label><span>{tr(locale, "名称", "Name")}</span><input value={node.name} onChange={(event) => mutate({ name: event.target.value })} /></label>{node.type === "source" && <label><span>{tr(locale, "数据集", "Dataset")}</span><select value={node.datasetId} onChange={(event) => mutate({ datasetId: event.target.value })}>{datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}</select></label>}{node.type === "filter" && <CodeField locale={locale} label={tr(locale, "保留条件", "Keep condition")} value={node.formula} placeholder="temperature > 30 AND running == TRUE" onChange={(formula) => mutate({ formula })} />}{node.type === "formula" && <><OutputFieldEditor locale={locale} node={node} mutate={mutate} /><CodeField locale={locale} label={tr(locale, "安全公式", "Safe formula")} value={node.formula} placeholder="ROUND(temperature * 1.8 + 32, 1)" onChange={(formula) => mutate({ formula })} /></>}{node.type === "script" && <><OutputFieldEditor locale={locale} node={node} mutate={mutate} /><CodeField locale={locale} label="JavaScript · QuickJS" value={node.source} placeholder="return input.temperature * 1.8 + 32;" onChange={(source) => mutate({ source })} /><small>{tr(locale, "隔离运行，无网络、文件、DOM 与 Node API。", "Runs in isolation without network, files, DOM or Node APIs.")}</small></>}{node.type === "sort" && <div className="pipeline-field-pair"><label><span>{tr(locale, "字段", "Field")}</span><input value={node.field} onChange={(event) => mutate({ field: event.target.value })} /></label><label><span>{tr(locale, "方向", "Direction")}</span><select value={node.direction} onChange={(event) => mutate({ direction: event.target.value as "asc" | "desc" })}><option value="asc">ASC</option><option value="desc">DESC</option></select></label></div>}{node.type === "limit" && <label><span>{tr(locale, "最多行数", "Maximum rows")}</span><input type="number" min="1" max="10000" value={node.count} onChange={(event) => mutate({ count: Math.max(1, Math.min(10000, Number(event.target.value))) })} /></label>}{node.type === "output" && <small>{tr(locale, "输出会成为可供 2D、3D 和接口共用的数据产品。", "The output becomes a data product shared by 2D, 3D and endpoints.")}</small>}</div></section>;
}

function PipelineResult({ locale, preview, selectedNodeId }: { locale: AppLocale; preview?: DataPipelinePreview | undefined; selectedNodeId?: string | undefined }) {
  const diagnostic = preview?.diagnostics.find((item) => item.nodeId === selectedNodeId);
  const rows = diagnostic?.sample ?? preview?.rows ?? [];
  const fields = rows[0] ? Object.keys(rows[0]) : [];
  return <section className="pipeline-result"><header><span><strong>{diagnostic ? tr(locale, "节点样例", "Node sample") : tr(locale, "运行结果", "Run result")}</strong><small>{preview ? `${diagnostic?.outputRows ?? preview.rows.length} ${tr(locale, "行", "rows")} · ${(diagnostic?.durationMs ?? preview.durationMs).toFixed(1)}ms` : tr(locale, "保存并运行后显示逐节点诊断", "Save and run for per-node diagnostics")}</small></span>{preview && <div className="pipeline-health"><Gauge size={13} />{preview.diagnostics.filter((item) => item.status === "success").length}/{preview.pipeline.nodes.length}</div>}</header>{diagnostic?.error ? <div className="pipeline-result-error"><XCircle size={18} /><span>{diagnostic.error}</span></div> : rows.length ? <div className="pipeline-result-table"><table><thead><tr>{fields.map((field) => <th key={field}>{field}</th>)}</tr></thead><tbody>{rows.slice(0, 20).map((row, index) => <tr key={index}>{fields.map((field) => <td key={field}>{formatValue(row[field])}</td>)}</tr>)}</tbody></table></div> : <div className="pipeline-panel-empty"><Box size={24} />{preview ? tr(locale, "当前节点没有输出数据", "This node has no output") : tr(locale, "尚未运行", "Not run yet")}</div>}</section>;
}

function OutputFieldEditor<T extends Extract<DataPipelineNode, { type: "formula" | "script" }>>({ locale, node, mutate }: { locale: AppLocale; node: T; mutate: (patch: Partial<T>) => void }) {
  return <><div className="pipeline-field-pair"><label><span>Key</span><input value={node.key} onChange={(event) => mutate({ key: event.target.value } as Partial<T>)} /></label><label><span>{tr(locale, "类型", "Type")}</span><select value={node.fieldType} onChange={(event) => mutate({ fieldType: event.target.value as DataFieldType } as Partial<T>)}><option value="number">Number</option><option value="string">String</option><option value="boolean">Boolean</option><option value="datetime">Datetime</option><option value="json">JSON</option></select></label></div><label><span>{tr(locale, "显示名", "Label")}</span><input value={node.label} onChange={(event) => mutate({ label: event.target.value } as Partial<T>)} /></label></>;
}

function CodeField({ label, value, placeholder, onChange }: { locale: AppLocale; label: string; value: string; placeholder: string; onChange: (value: string) => void }) {
  return <label><span>{label}</span><textarea spellCheck={false} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} /></label>;
}

function NodeAddButton({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) { return <button title={label} onClick={onClick}>{icon}<span>{label}</span></button>; }

function createTransformNode(type: TransformNodeType, locale: AppLocale): DataPipelineNode {
  const base = { id: crypto.randomUUID(), position: { x: 0, y: 0 } };
  if (type === "filter") return { ...base, type, name: tr(locale, "条件过滤", "Filter rows"), formula: "TRUE" };
  if (type === "formula") return { ...base, type, name: tr(locale, "公式计算", "Formula"), key: "computed_value", label: tr(locale, "计算值", "Computed value"), fieldType: "number", formula: "ROUND(value, 2)" };
  if (type === "script") return { ...base, type, name: tr(locale, "脚本处理", "Script"), key: "script_value", label: tr(locale, "脚本值", "Script value"), fieldType: "number", source: "return input.value;" };
  if (type === "sort") return { ...base, type, name: tr(locale, "字段排序", "Sort rows"), field: "value", direction: "desc" };
  return { ...base, type, name: tr(locale, "限制数量", "Limit rows"), count: 100 };
}

function normalizeLinearPipeline(definition: DataPipelineDefinition): DataPipelineDefinition {
  const nodes = definition.nodes.map((node, index) => ({ ...node, position: { x: index * 240, y: 0 } }));
  return { ...definition, nodes, edges: nodes.slice(1).map((node, index) => ({ id: definition.edges[index]?.id ?? crypto.randomUUID(), sourceNodeId: nodes[index]!.id, targetNodeId: node.id })) };
}

function nodeIcon(type: DataPipelineNode["type"]): ReactNode {
  if (type === "source") return <Database size={17} />;
  if (type === "filter") return <Filter size={17} />;
  if (type === "formula") return <Calculator size={17} />;
  if (type === "script") return <Code2 size={17} />;
  if (type === "sort") return <ArrowDownAZ size={17} />;
  if (type === "limit") return <ListEnd size={17} />;
  if (type === "merge") return <GitBranch size={17} />;
  return <Box size={17} />;
}

function nodeTypeLabel(type: DataPipelineNode["type"]): string { return ({ source: "DATASET", filter: "FILTER", formula: "FORMULA", script: "QUICKJS", sort: "SORT", limit: "LIMIT", merge: "MERGE", output: "OUTPUT" })[type]; }

function nodeSummary(node: DataPipelineNode): string {
  if (node.type === "source") return "Dataset";
  if (node.type === "filter") return node.formula;
  if (node.type === "formula" || node.type === "script") return `→ ${node.key}`;
  if (node.type === "sort") return `${node.field} · ${node.direction.toUpperCase()}`;
  if (node.type === "limit") return `${node.count} rows`;
  if (node.type === "merge") return "Union";
  return "Data product";
}

function formatValue(value: unknown): string { if (value === null || value === undefined) return "—"; return typeof value === "object" ? JSON.stringify(value) : String(value); }
function errorMessage(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }
