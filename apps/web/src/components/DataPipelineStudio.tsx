import { useEffect, useMemo, useState, type DragEvent } from "react";
import {
  ArrowRight,
  GitBranch,
  LoaderCircle,
  Play,
  Plus,
  Save,
  XCircle,
} from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type {
  DataDatasetRecord,
  DataPipelineDefinition,
  DataPipelineNode,
  DataPipelinePreview,
} from "@bim-studio/contracts";
import { api } from "../api";
import { DataPipelineCanvas } from "./DataPipelineCanvas";
import { DataPipelineDebugPanel } from "./DataPipelineDebugPanel";
import { insertPipelineNodeAfter } from "./DataPipelineEditing";
import { DataPipelineLibrary } from "./DataPipelineLibrary";
import {
  NodeInspector,
  createTransformNode,
  errorMessage,
  derivePipelineFieldHints,
  normalizeLinearPipeline,
  validatePipelineDraft,
  type TransformNodeType,
} from "./DataPipelineStudioParts";

export function DataPipelineStudio({
  locale,
  projectId,
  datasets,
  onError,
  onOpenEndpoints,
}: {
  locale: AppLocale;
  projectId: string;
  datasets: DataDatasetRecord[];
  onError: (message: string) => void;
  onOpenEndpoints: (pipelineId: string) => void;
}) {
  const [pipelines, setPipelines] = useState<DataPipelineDefinition[]>([]);
  const [draft, setDraft] = useState<DataPipelineDefinition>();
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [preview, setPreview] = useState<DataPipelinePreview>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draggedNodeId, setDraggedNodeId] = useState<string>();
  const [validationMessage, setValidationMessage] = useState<string>();

  async function load(preferredId?: string) {
    setLoading(true);
    try {
      const next = await api.listDataPipelines(projectId);
      setPipelines(next);
      const selected = next.find((item) => item.id === preferredId) ?? next[0];
      setDraft(selected ? structuredClone(selected) : undefined);
      setSelectedNodeId(selected?.nodes[0]?.id);
      setPreview(undefined);
      setValidationMessage(undefined);
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [projectId]);

  function createPipeline() {
    if (isDirty && !window.confirm(tr(locale, "当前流程有未保存更改，仍要新建流程吗？", "Discard unsaved changes and create a new pipeline?"))) return;
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
    setValidationMessage(undefined);
  }

  async function save(runAfter = false, throughNodeId?: string) {
    if (!draft) return;
    const validationError = validatePipelineDraft(draft, datasets);
    if (validationError) {
      setValidationMessage(validationError);
      onError(validationError);
      return;
    }
    setValidationMessage(undefined);
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
        const result = await api.previewDataPipeline(projectId, saved.id, throughNodeId);
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

  function addNode(type: TransformNodeType, afterNodeId = selectedNodeId) {
    if (!draft) return;
    const outputIndex = draft.nodes.findIndex((item) => item.type === "output");
    const fallbackIndex = outputIndex < 0 ? draft.nodes.length : outputIndex;
    const selectedIndex = draft.nodes.findIndex((item) => item.id === afterNodeId);
    const insertIndex = selectedIndex < 0
      ? fallbackIndex
      : Math.min(selectedIndex + 1, fallbackIndex);
    const fieldsAtInsertion = derivePipelineFieldHints(
      draft.nodes,
      draft.nodes[insertIndex]?.id,
      datasetFields,
    );
    const node = createTransformNode(type, locale, fieldsAtInsertion);
    setDraft(insertPipelineNodeAfter(draft, node, afterNodeId));
    setSelectedNodeId(node.id);
    setPreview(undefined);
    setValidationMessage(undefined);
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
    setValidationMessage(undefined);
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
    setValidationMessage(undefined);
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
    setValidationMessage(undefined);
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
    setValidationMessage(undefined);
  }

  const selectedNode = draft?.nodes.find((node) => node.id === selectedNodeId);
  const sourceNode = draft?.nodes.find((node): node is Extract<DataPipelineNode, { type: "source" }> => node.type === "source");
  const datasetFields = datasets.find((dataset) => dataset.id === sourceNode?.datasetId)?.fields ?? [];
  const sourceFields = derivePipelineFieldHints(draft?.nodes ?? [], selectedNodeId, datasetFields);
  const diagnostics = useMemo(
    () =>
      new Map(preview?.diagnostics.map((item) => [item.nodeId, item]) ?? []),
    [preview],
  );
  const savedDraft = draft ? pipelines.find((pipeline) => pipeline.id === draft.id) : undefined;
  const isDirty = Boolean(draft && JSON.stringify(savedDraft) !== JSON.stringify(draft));

  function selectPipeline(pipeline: DataPipelineDefinition) {
    if (pipeline.id === draft?.id) return;
    if (isDirty && !window.confirm(tr(locale, "当前流程有未保存更改，仍要切换吗？", "Discard unsaved changes and switch pipelines?"))) return;
    setDraft(structuredClone(pipeline));
    setSelectedNodeId(pipeline.nodes[0]?.id);
    setPreview(undefined);
    setValidationMessage(undefined);
  }

  return (
    <div className="pipeline-studio">
      <DataPipelineLibrary
        locale={locale}
        pipelines={pipelines}
        activeId={draft?.id}
        canCreate={Boolean(datasets.length)}
        canInsert={Boolean(draft && selectedNode?.type !== "output")}
        loading={loading}
        onCreate={createPipeline}
        onSelect={selectPipeline}
        onRemove={(pipeline) => void removePipeline(pipeline)}
        onInsert={(type) => addNode(type)}
      />
      <section className={`pipeline-workspace ${validationMessage ? "has-validation" : ""}`}>
        {!draft && loading ? (
          <div className="pipeline-blank">
            <LoaderCircle className="spin" size={28} />
            <strong>{tr(locale, "正在加载处理流程", "Loading pipelines")}</strong>
          </div>
        ) : !draft ? (
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
              <div className="pipeline-name-field">
                <input
                  aria-label={tr(locale, "流水线名称", "Pipeline name")}
                  value={draft.name}
                  onChange={(event) => {
                    setDraft({ ...draft, name: event.target.value });
                  }}
                />
                <span className={preview?.status === "success" ? "success" : preview?.status === "error" ? "error" : isDirty ? "dirty" : "saved"}>
                  <i />
                  {preview?.status === "success"
                    ? preview.executedThroughNodeId
                      ? tr(locale, `调试完成 · ${preview.rows.length} 行`, `Debug complete · ${preview.rows.length} rows`)
                      : tr(locale, `运行成功 · ${preview.rows.length} 行`, `Run succeeded · ${preview.rows.length} rows`)
                    : preview?.status === "error"
                      ? tr(locale, "运行失败", "Run failed")
                      : isDirty
                      ? tr(locale, "未保存", "Unsaved")
                      : tr(locale, "已保存", "Saved")}
                </span>
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
                  {tr(locale, "运行", "Run")}
                </button>
                {preview?.status === "success" && !preview.executedThroughNodeId && (
                  <button onClick={() => onOpenEndpoints(draft.id)}>
                    {tr(locale, "发布接口", "Publish API")}
                    <ArrowRight size={14} />
                  </button>
                )}
              </div>
            </header>
            {validationMessage && <div className="pipeline-validation-banner"><XCircle size={14} /><span>{validationMessage}</span></div>}
            <DataPipelineCanvas
              locale={locale}
              nodes={draft.nodes}
              selectedNodeId={selectedNodeId}
              diagnostics={diagnostics}
              onSelect={setSelectedNodeId}
              onDragStart={setDraggedNodeId}
              onDrop={dropNode}
              onInsert={addNode}
            />
            <div className="pipeline-lower">
              <NodeInspector
                locale={locale}
                node={selectedNode}
                datasets={datasets}
                sourceFields={sourceFields}
                onChange={updateNode}
                onRemove={removeNode}
                onMove={moveNode}
              />
              <DataPipelineDebugPanel
                locale={locale}
                preview={preview}
                selectedNode={selectedNode}
                busy={busy}
                onRunThrough={() => void save(true, selectedNodeId)}
              />
            </div>
          </>
        )}
      </section>
    </div>
  );
}
