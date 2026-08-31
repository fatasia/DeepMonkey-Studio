import {
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import {
  ArrowDownAZ,
  ArrowLeft,
  ArrowRight,
  Box,
  Braces,
  Calculator,
  CheckCircle2,
  Code2,
  Database,
  Filter,
  Gauge,
  GitBranch,
  GripVertical,
  ListEnd,
  LoaderCircle,
  Play,
  Plus,
  Save,
  Trash2,
  XCircle,
} from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type {
  DataDatasetRecord,
  DataFieldType,
  DataPipelineDefinition,
  DataPipelineNode,
  DataPipelineNodeDiagnostic,
  DataPipelinePreview,
} from "@bim-studio/contracts";
import { api } from "../api";
import {
  NodeAddButton,
  NodeInspector,
  PipelineNodeCard,
  PipelineResult,
  createTransformNode,
  errorMessage,
  normalizeLinearPipeline,
  type TransformNodeType,
} from "./DataPipelineStudioParts";

export function DataPipelineStudio({
  locale,
  projectId,
  datasets,
  onError,
}: {
  locale: AppLocale;
  projectId: string;
  datasets: DataDatasetRecord[];
  onError: (message: string) => void;
}) {
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

  useEffect(() => {
    void load();
  }, [projectId]);

  function createPipeline() {
    const dataset = datasets[0];
    if (!dataset) {
      onError(
        tr(
          locale,
          "请先创建数据集，再编排逻辑。",
          "Create a dataset before building a pipeline.",
        ),
      );
      return;
    }
    const now = new Date().toISOString();
    const sourceId = crypto.randomUUID();
    const outputId = crypto.randomUUID();
    const next: DataPipelineDefinition = {
      id: crypto.randomUUID(),
      projectId,
      name: tr(locale, "新数据流水线", "New data pipeline"),
      createdAt: now,
      updatedAt: now,
      nodes: [
        {
          id: sourceId,
          type: "source",
          name: dataset.name,
          datasetId: dataset.id,
          position: { x: 0, y: 0 },
        },
        {
          id: outputId,
          type: "output",
          name: tr(locale, "数据产品", "Data product"),
          position: { x: 240, y: 0 },
        },
      ],
      edges: [
        {
          id: crypto.randomUUID(),
          sourceNodeId: sourceId,
          targetNodeId: outputId,
        },
      ],
    };
    setDraft(next);
    setSelectedNodeId(sourceId);
    setPreview(undefined);
  }

  async function save(runAfter = false) {
    if (!draft) return;
    setBusy(true);
    onError("");
    try {
      const normalized = normalizeLinearPipeline(draft);
      const saved = await api.saveDataPipeline(projectId, normalized);
      const nextPipelines = [
        ...pipelines.filter((item) => item.id !== saved.id),
        saved,
      ];
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
    if (
      !window.confirm(
        tr(
          locale,
          `删除流水线“${pipeline.name}”？`,
          `Delete pipeline “${pipeline.name}”?`,
        ),
      )
    )
      return;
    try {
      await api.deleteDataPipeline(projectId, pipeline.id);
      await load();
    } catch (reason) {
      onError(errorMessage(reason));
    }
  }

  function addNode(type: TransformNodeType) {
    if (!draft) return;
    const node = createTransformNode(type, locale);
    const outputIndex = draft.nodes.findIndex((item) => item.type === "output");
    const nodes = [...draft.nodes];
    nodes.splice(outputIndex < 0 ? nodes.length : outputIndex, 0, node);
    setDraft(normalizeLinearPipeline({ ...draft, nodes }));
    setSelectedNodeId(node.id);
    setPreview(undefined);
  }

  function updateNode(updater: (node: DataPipelineNode) => DataPipelineNode) {
    if (!draft || !selectedNodeId) return;
    setDraft({
      ...draft,
      nodes: draft.nodes.map((node) =>
        node.id === selectedNodeId ? updater(node) : node,
      ),
    });
    setPreview(undefined);
  }

  function removeNode(nodeId: string) {
    if (!draft) return;
    const node = draft.nodes.find((item) => item.id === nodeId);
    if (!node || node.type === "source" || node.type === "output") return;
    const nodes = draft.nodes.filter((item) => item.id !== nodeId);
    setDraft(normalizeLinearPipeline({ ...draft, nodes }));
    setSelectedNodeId(
      nodes[
        Math.max(0, draft.nodes.findIndex((item) => item.id === nodeId) - 1)
      ]?.id,
    );
    setPreview(undefined);
  }

  function moveNode(nodeId: string, offset: -1 | 1) {
    if (!draft) return;
    const index = draft.nodes.findIndex((item) => item.id === nodeId);
    const target = index + offset;
    if (index <= 0 || target <= 0 || target >= draft.nodes.length - 1) return;
    const nodes = [...draft.nodes];
    [nodes[index], nodes[target]] = [nodes[target]!, nodes[index]!];
    setDraft(normalizeLinearPipeline({ ...draft, nodes }));
    setPreview(undefined);
  }

  function dropNode(event: DragEvent, targetId: string) {
    event.preventDefault();
    if (!draft || !draggedNodeId || draggedNodeId === targetId) return;
    const moving = draft.nodes.find((node) => node.id === draggedNodeId);
    const target = draft.nodes.find((node) => node.id === targetId);
    if (
      !moving ||
      moving.type === "source" ||
      moving.type === "output" ||
      !target ||
      target.type === "source"
    )
      return;
    const nodes = draft.nodes.filter((node) => node.id !== draggedNodeId);
    nodes.splice(
      nodes.findIndex((node) => node.id === targetId),
      0,
      moving,
    );
    setDraft(normalizeLinearPipeline({ ...draft, nodes }));
    setDraggedNodeId(undefined);
    setPreview(undefined);
  }

  const selectedNode = draft?.nodes.find((node) => node.id === selectedNodeId);
  const diagnostics = useMemo(
    () =>
      new Map(preview?.diagnostics.map((item) => [item.nodeId, item]) ?? []),
    [preview],
  );

  return (
    <div className="pipeline-studio">
      <aside className="pipeline-library">
        <header>
          <span>
            <strong>{tr(locale, "逻辑流水线", "Logic pipelines")}</strong>
            <small>
              {pipelines.length} {tr(locale, "个流程", "flows")}
            </small>
          </span>
          <button disabled={!datasets.length} onClick={createPipeline}>
            <Plus size={14} />
            {tr(locale, "新建", "New")}
          </button>
        </header>
        <div className="pipeline-list">
          {pipelines.map((pipeline) => (
            <article
              className={draft?.id === pipeline.id ? "active" : ""}
              key={pipeline.id}
            >
              <button
                onClick={() => {
                  setDraft(structuredClone(pipeline));
                  setSelectedNodeId(pipeline.nodes[0]?.id);
                  setPreview(undefined);
                }}
              >
                <GitBranch size={16} />
                <span>
                  <strong>{pipeline.name}</strong>
                  <small>
                    {pipeline.nodes.length} {tr(locale, "个节点", "nodes")}
                  </small>
                </span>
              </button>
              <button
                className="icon danger"
                title={tr(locale, "删除", "Delete")}
                onClick={() => void removePipeline(pipeline)}
              >
                <Trash2 size={13} />
              </button>
            </article>
          ))}
        </div>
        {!pipelines.length && (
          <div className="pipeline-empty">
            <GitBranch size={24} />
            <strong>
              {tr(
                locale,
                "从一条轻量流程开始",
                "Start with a lightweight flow",
              )}
            </strong>
            <span>
              {tr(
                locale,
                "选数据集，添加处理节点，立即查看每一步结果。",
                "Choose a dataset, add transforms, and inspect every step.",
              )}
            </span>
          </div>
        )}
      </aside>
      <section className="pipeline-workspace">
        {!draft ? (
          <div className="pipeline-blank">
            <GitBranch size={32} />
            <strong>
              {tr(locale, "可视化编排数据逻辑", "Build data logic visually")}
            </strong>
            <span>
              {datasets.length
                ? tr(
                    locale,
                    "创建流水线后，用节点完成过滤、计算、脚本、排序与输出。",
                    "Create a pipeline for filtering, calculations, scripts, sorting and output.",
                  )
                : tr(
                    locale,
                    "先在数据准备中创建一个数据集。",
                    "Create a dataset in Data preparation first.",
                  )}
            </span>
            <button disabled={!datasets.length} onClick={createPipeline}>
              <Plus size={14} />
              {tr(locale, "创建流水线", "Create pipeline")}
            </button>
          </div>
        ) : (
          <>
            <header className="pipeline-toolbar">
              <input
                aria-label={tr(locale, "流水线名称", "Pipeline name")}
                value={draft.name}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
              <div className="pipeline-add-nodes">
                <span>{tr(locale, "添加处理", "Add transform")}</span>
                <NodeAddButton
                  icon={<Filter />}
                  label={tr(locale, "过滤", "Filter")}
                  onClick={() => addNode("filter")}
                />
                <NodeAddButton
                  icon={<Calculator />}
                  label={tr(locale, "公式", "Formula")}
                  onClick={() => addNode("formula")}
                />
                <NodeAddButton
                  icon={<Code2 />}
                  label={tr(locale, "脚本", "Script")}
                  onClick={() => addNode("script")}
                />
                <NodeAddButton
                  icon={<ArrowDownAZ />}
                  label={tr(locale, "排序", "Sort")}
                  onClick={() => addNode("sort")}
                />
                <NodeAddButton
                  icon={<ListEnd />}
                  label={tr(locale, "限量", "Limit")}
                  onClick={() => addNode("limit")}
                />
              </div>
              <div className="pipeline-actions">
                <button
                  disabled={busy || !draft.name.trim()}
                  onClick={() => void save()}
                >
                  <Save size={14} />
                  {tr(locale, "保存", "Save")}
                </button>
                <button
                  className="primary"
                  disabled={busy || !draft.name.trim()}
                  onClick={() => void save(true)}
                >
                  {busy ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <Play size={14} />
                  )}
                  {tr(locale, "保存并运行", "Save & run")}
                </button>
              </div>
            </header>
            <div className="pipeline-canvas">
              {draft.nodes.map((node, index) => (
                <div className="pipeline-node-wrap" key={node.id}>
                  {index > 0 && (
                    <i className="pipeline-edge">
                      <span />
                    </i>
                  )}
                  <PipelineNodeCard
                    node={node}
                    selected={node.id === selectedNodeId}
                    diagnostic={diagnostics.get(node.id)}
                    draggable={node.type !== "source" && node.type !== "output"}
                    onDragStart={() => setDraggedNodeId(node.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => dropNode(event, node.id)}
                    onSelect={() => setSelectedNodeId(node.id)}
                  />
                </div>
              ))}
            </div>
            <div className="pipeline-lower">
              <NodeInspector
                locale={locale}
                node={selectedNode}
                datasets={datasets}
                onChange={updateNode}
                onRemove={removeNode}
                onMove={moveNode}
              />
              <PipelineResult
                locale={locale}
                preview={preview}
                selectedNodeId={selectedNodeId}
              />
            </div>
          </>
        )}
      </section>
    </div>
  );
}
