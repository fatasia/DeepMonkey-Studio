import { Database, LoaderCircle, Play, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { DataDatasetField, DataEventAction, DataEventTarget, DataMessage, DataPipelineDefinition, DataDatasetRecord, DirectBindingSpec, SceneDataBindingState } from "@bim-studio/contracts";
import { api } from "../api";
import { dataBindingProduct, directSceneDataBindingMessage, sameDataBindingTarget, sceneDataBindingMessage, type DataProductPreview } from "../sceneDataBindings";
import { translate as tr, type AppLocale } from "../i18n";
import { testDirectBinding } from "../directBindingRuntime";
import { createDefaultDirectBinding, DirectBindingEditor } from "./DirectBindingEditor";

export interface SceneDataBindingRuntimeState {
  status: "loading" | "ready" | "error";
  value?: unknown;
  updatedAt?: string;
  error?: string;
}

interface DataProductOption {
  kind: "dataset" | "pipeline";
  id: string;
  name: string;
}

const ACTIONS: readonly DataEventAction[] = ["color", "visibility", "opacity", "position", "animation", "effects", "focus"];

export function SceneDataBindingEditor({ locale, projectId, sceneId, target, targetName, bindings, runtimeStates, disabled = false, onChange, onTest, onOpenData }: {
  locale: AppLocale;
  projectId: string;
  sceneId: string;
  target: DataEventTarget;
  targetName: string;
  bindings: SceneDataBindingState[];
  runtimeStates: Readonly<Record<string, SceneDataBindingRuntimeState>>;
  disabled?: boolean;
  onChange: (bindings: SceneDataBindingState[]) => void;
  onTest: (bindingId: string, message: DataMessage) => void;
  onOpenData: () => void;
}) {
  const [datasets, setDatasets] = useState<DataDatasetRecord[]>([]);
  const [pipelines, setPipelines] = useState<DataPipelineDefinition[]>([]);
  const [fieldsByProduct, setFieldsByProduct] = useState<Record<string, DataDatasetField[]>>({});
  const [previews, setPreviews] = useState<Record<string, DataProductPreview>>({});
  const [catalogStatus, setCatalogStatus] = useState<"loading" | "ready" | "error">("loading");
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({});
  const [testingId, setTestingId] = useState<string>();
  const targetBindings = useMemo(() => bindings.filter((binding) => sameDataBindingTarget(binding.target, target)), [bindings, target]);
  const products = useMemo<DataProductOption[]>(() => [
    ...pipelines.map((pipeline) => ({ kind: "pipeline" as const, id: pipeline.id, name: pipeline.name })),
    ...datasets.map((dataset) => ({ kind: "dataset" as const, id: dataset.id, name: dataset.name }))
  ], [datasets, pipelines]);

  useEffect(() => {
    let cancelled = false;
    setCatalogStatus("loading");
    void Promise.all([api.listDatasets(projectId), api.listDataPipelines(projectId)]).then(([nextDatasets, nextPipelines]) => {
      if (cancelled) return;
      setDatasets(nextDatasets);
      setPipelines(nextPipelines);
      setFieldsByProduct((current) => ({ ...current, ...Object.fromEntries(nextDatasets.map((dataset) => [productKey("dataset", dataset.id), dataset.fields])) }));
      setCatalogStatus("ready");
    }).catch(() => { if (!cancelled) setCatalogStatus("error"); });
    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    const referenced = [...new Map(targetBindings.filter((binding) => !binding.directBinding).map((binding) => {
      const product = dataBindingProduct(binding);
      return [productKey(product.kind, product.id), product] as const;
    })).values()].filter((product) => !previews[productKey(product.kind, product.id)]);
    if (referenced.length === 0) return;
    void Promise.all(referenced.map(async (product) => {
      try {
        const preview = await loadPreview(projectId, product.kind, product.id);
        if (!cancelled) {
          const key = productKey(product.kind, product.id);
          setPreviews((current) => ({ ...current, [key]: preview }));
          setFieldsByProduct((current) => ({ ...current, [key]: preview.fields }));
          setPreviewErrors((current) => withoutKey(current, key));
        }
      } catch (reason) {
        if (!cancelled) setPreviewErrors((current) => ({ ...current, [productKey(product.kind, product.id)]: errorMessage(reason) }));
      }
    }));
    return () => { cancelled = true; };
  }, [projectId, targetBindings]);

  async function addBinding() {
    const product = products[0];
    if (!product) return;
    const preview = await ensurePreview(product.kind, product.id).catch(() => undefined);
    const field = preferredField(preview?.fields ?? fieldsByProduct[productKey(product.kind, product.id)] ?? []);
    if (!field) return;
    const binding: SceneDataBindingState = {
      id: crypto.randomUUID(),
      name: `${targetName} · ${field.label}`,
      enabled: true,
      ...(product.kind === "pipeline" ? { pipelineId: product.id } : { datasetId: product.id }),
      field: field.key,
      rowIndex: 0,
      target: { ...target },
      action: suggestedAction(field),
      refreshSeconds: 5
    };
    onChange([...bindings, binding]);
  }

  function addDirectBinding() {
    onChange([...bindings, {
      id: crypto.randomUUID(), name: `${targetName} · ${tr(locale, "直接接口", "Direct interface")}`,
      enabled: true, directBinding: createDefaultDirectBinding(), field: "value", target: { ...target }, action: "visibility", refreshSeconds: 5
    }]);
  }

  function updateBinding(id: string, patch: Partial<SceneDataBindingState>) {
    onChange(bindings.map((binding) => binding.id === id ? { ...binding, ...patch } : binding));
  }

  function switchToDirect(binding: SceneDataBindingState) {
    const next = { ...binding, directBinding: createDefaultDirectBinding(), field: "value" };
    delete next.datasetId;
    delete next.pipelineId;
    onChange(bindings.map((candidate) => candidate.id === binding.id ? next : candidate));
  }

  async function selectProduct(binding: SceneDataBindingState, value: string) {
    const [kind, id] = value.split(":", 2) as ["dataset" | "pipeline", string];
    const preview = await ensurePreview(kind, id).catch(() => undefined);
    const field = preferredField(preview?.fields ?? fieldsByProduct[productKey(kind, id)] ?? []);
    const next = { ...binding };
    delete next.datasetId;
    delete next.pipelineId;
    delete next.directBinding;
    if (kind === "pipeline") next.pipelineId = id;
    else next.datasetId = id;
    if (field) {
      next.field = field.key;
      next.name = `${targetName} · ${field.label}`;
      next.action = suggestedAction(field);
    }
    onChange(bindings.map((candidate) => candidate.id === binding.id ? next : candidate));
  }

  async function ensurePreview(kind: "dataset" | "pipeline", id: string): Promise<DataProductPreview> {
    const key = productKey(kind, id);
    const cached = previews[key];
    if (cached) return cached;
    const preview = await loadPreview(projectId, kind, id);
    setPreviews((current) => ({ ...current, [key]: preview }));
    setFieldsByProduct((current) => ({ ...current, [key]: preview.fields }));
    setPreviewErrors((current) => withoutKey(current, key));
    return preview;
  }

  async function testBinding(binding: SceneDataBindingState) {
    setTestingId(binding.id);
    try {
      if (binding.directBinding) {
        const value = await testDirectBinding(binding.directBinding);
        onTest(binding.id, directSceneDataBindingMessage(binding, value, sceneId));
        return;
      }
      const product = dataBindingProduct(binding);
      const preview = await ensurePreview(product.kind, product.id);
      onTest(binding.id, sceneDataBindingMessage(binding, preview, sceneId));
    } catch (reason) {
      const key = binding.directBinding ? `direct:${binding.id}` : (() => { const product = dataBindingProduct(binding); return productKey(product.kind, product.id); })();
      setPreviewErrors((current) => ({ ...current, [key]: errorMessage(reason) }));
    } finally {
      setTestingId(undefined);
    }
  }

  return <details className="scene-data-binding-editor" open>
    <summary><span>{tr(locale, "数据绑定", "Data bindings")}</span><small>{targetBindings.filter((binding) => binding.enabled).length}</small></summary>
    <div className="scene-data-binding-body">
      <header><div><strong>{targetName}</strong><small>{tr(locale, "数据产品直接驱动当前对象", "Data products directly drive this object")}</small></div><button onClick={onOpenData}><Database size={12} />{tr(locale, "数据中心", "Data Center")}</button></header>
      {catalogStatus === "loading" && <div className="scene-data-binding-empty"><LoaderCircle className="spin" size={15} />{tr(locale, "正在读取数据产品…", "Loading data products…")}</div>}
      {catalogStatus === "error" && <div className="scene-data-binding-empty error">{tr(locale, "数据中台暂不可用，直接 HTTP / WebSocket 仍可使用。", "The data platform is unavailable; direct HTTP / WebSocket remains available.")}</div>}
      {catalogStatus === "ready" && products.length === 0 && <div className="scene-data-binding-empty"><span>{tr(locale, "还没有可绑定的数据产品", "No data products are available")}</span><button onClick={onOpenData}>{tr(locale, "创建数据管道", "Create a data pipeline")}</button></div>}
      {targetBindings.map((binding) => {
        const product = binding.directBinding ? undefined : dataBindingProduct(binding);
        const key = product ? productKey(product.kind, product.id) : `direct:${binding.id}`;
        const fields = fieldsByProduct[key] ?? [];
        const runtime = runtimeStates[binding.id];
        const error = previewErrors[key] ?? runtime?.error;
        return <article className="scene-data-binding-card" key={binding.id}>
          <header><label><input disabled={disabled} type="checkbox" checked={binding.enabled} onChange={(event) => updateBinding(binding.id, { enabled: event.target.checked })} /><input disabled={disabled} value={binding.name} aria-label={tr(locale, "绑定名称", "Binding name")} onChange={(event) => updateBinding(binding.id, { name: event.target.value })} /></label><button disabled={disabled} className="danger" title={tr(locale, "删除绑定", "Delete binding")} onClick={() => onChange(bindings.filter((candidate) => candidate.id !== binding.id))}><Trash2 size={12} /></button></header>
          <label><span>{tr(locale, "数据来源", "Data source")}</span><select disabled={disabled} value={binding.directBinding ? "direct" : "platform"} onChange={(event) => {
            if (event.target.value === "direct") switchToDirect(binding);
            else if (products[0]) void selectProduct(binding, `${products[0].kind}:${products[0].id}`);
          }}><option value="platform">{tr(locale, "数据中台", "Data platform")}</option><option value="direct">{tr(locale, "直接 HTTP / WebSocket", "Direct HTTP / WebSocket")}</option></select></label>
          {binding.directBinding ? <DirectBindingEditor locale={locale} value={binding.directBinding} disabled={disabled} onChange={(directBinding: DirectBindingSpec) => updateBinding(binding.id, { directBinding })} /> : <>
          <label><span>{tr(locale, "数据产品", "Data product")}</span><select disabled={disabled} value={`${product!.kind}:${product!.id}`} onChange={(event) => void selectProduct(binding, event.target.value)}>{pipelines.length > 0 && <optgroup label={tr(locale, "数据管道（推荐）", "Data pipelines (recommended)")}>{pipelines.map((pipeline) => <option key={pipeline.id} value={`pipeline:${pipeline.id}`}>{pipeline.name}</option>)}</optgroup>}{datasets.length > 0 && <optgroup label={tr(locale, "原始数据集", "Raw datasets")}>{datasets.map((dataset) => <option key={dataset.id} value={`dataset:${dataset.id}`}>{dataset.name}</option>)}</optgroup>}</select></label>
          </>}
          <div className="scene-data-binding-grid"><label><span>{tr(locale, "字段", "Field")}</span>{binding.directBinding ? <input disabled={disabled} value={binding.field} onChange={(event) => updateBinding(binding.id, { field: event.target.value })} /> : <select disabled={disabled} value={binding.field} onChange={(event) => {
            const field = fields.find((candidate) => candidate.key === event.target.value);
            const previous = fields.find((candidate) => candidate.key === binding.field);
            const autoNamed = binding.name === `${targetName} · ${previous?.label ?? binding.field}`;
            updateBinding(binding.id, {
              field: event.target.value,
              ...(field ? { action: suggestedAction(field) } : {}),
              ...(field && autoNamed ? { name: `${targetName} · ${field.label}` } : {})
            });
          }}>{fields.length === 0 && <option value={binding.field}>{binding.field}</option>}{fields.map((field) => <option key={field.key} value={field.key}>{field.label}{field.unit ? ` · ${field.unit}` : ""}</option>)}</select>}</label><label><span>{tr(locale, "驱动动作", "Action")}</span><select disabled={disabled} value={binding.action} onChange={(event) => updateBinding(binding.id, { action: event.target.value as DataEventAction })}>{ACTIONS.map((action) => <option key={action} value={action}>{actionLabel(action, locale)}</option>)}</select></label></div>
          <small className="scene-data-binding-action-hint">{actionHint(binding.action, locale)}</small>
          {!binding.directBinding && <label><span>{tr(locale, "刷新周期", "Refresh")}</span><div className="scene-data-binding-refresh"><input disabled={disabled} type="range" min="2" max="60" step="1" value={binding.refreshSeconds} onChange={(event) => updateBinding(binding.id, { refreshSeconds: Number(event.target.value) })} /><output>{binding.refreshSeconds}s</output></div></label>}
          <footer><div className={`scene-data-binding-status ${runtime?.status ?? "idle"}`}><i /><span>{error ? error : runtime?.status === "ready" ? `${tr(locale, "当前值", "Current")}: ${formatValue(runtime.value)}` : tr(locale, "等待数据", "Waiting for data")}</span></div><button disabled={disabled || testingId === binding.id} onClick={() => void testBinding(binding)}>{testingId === binding.id ? <LoaderCircle className="spin" size={12} /> : <Play size={12} />}{tr(locale, "测试", "Test")}</button></footer>
        </article>;
      })}
      <div><button className="scene-data-binding-add" disabled={disabled || products.length === 0 || catalogStatus !== "ready"} onClick={() => void addBinding()}><Plus size={13} />{tr(locale, "添加中台绑定", "Add platform binding")}</button><button className="scene-data-binding-add" disabled={disabled} onClick={addDirectBinding}><Plus size={13} />{tr(locale, "添加直接接口", "Add direct interface")}</button></div>
      <p>{tr(locale, "数据管道也可绑定二维组件并发布为 REST / WebSocket；这里只配置数据如何作用于三维对象。", "The same pipeline can bind 2D widgets and publish REST/WebSocket endpoints; this panel only defines how its data affects the 3D object.")}</p>
    </div>
  </details>;
}

async function loadPreview(projectId: string, kind: "dataset" | "pipeline", id: string): Promise<DataProductPreview> {
  if (kind === "dataset") return api.previewDataset(projectId, id);
  const preview = await api.previewDataPipeline(projectId, id);
  if (preview.status === "error") throw new Error(preview.error || "数据管道运行失败");
  return preview;
}

function suggestedAction(field: DataDatasetField): DataEventAction {
  const key = field.key.toLowerCase();
  if (key.includes("color") || key.includes("colour")) return "color";
  if (key.includes("visible") || key.includes("online") || field.type === "boolean") return "visibility";
  if (key.includes("opacity") || key.includes("alpha")) return "opacity";
  if (key.includes("position") || key.includes("location")) return "position";
  return field.type === "json" ? "effects" : "visibility";
}

function preferredField(fields: readonly DataDatasetField[]): DataDatasetField | undefined {
  return fields.find((field) => field.type === "boolean")
    ?? fields.find((field) => /colou?r|opacity|alpha|position|location/i.test(field.key))
    ?? fields.find((field) => field.type === "json")
    ?? fields.find((field) => field.type === "number")
    ?? fields[0];
}

function actionLabel(action: DataEventAction, locale: AppLocale): string {
  const labels: Record<DataEventAction, [string, string]> = {
    color: ["颜色", "Color"], visibility: ["显示 / 隐藏", "Visibility"], opacity: ["透明度", "Opacity"], position: ["位置", "Position"], animation: ["动画播放", "Animation"], effects: ["模型特效", "Effects"], focus: ["镜头定位", "Camera focus"], label: ["标注文字", "Annotation label"]
  };
  return labels[action][locale === "zh-CN" ? 0 : 1];
}

function actionHint(action: DataEventAction, locale: AppLocale): string {
  const hints: Record<DataEventAction, [string, string]> = {
    color: ["字段需输出 #RRGGBB 颜色", "Field must output a #RRGGBB color"],
    visibility: ["布尔值控制显示与隐藏", "A boolean controls visibility"],
    opacity: ["数字会限制在 0–1", "Numbers are clamped to 0–1"],
    position: ["字段需输出 {x, y, z}", "Field must output {x, y, z}"],
    animation: ["布尔值控制模型动画", "A boolean controls model animation"],
    effects: ["字段需输出特效 JSON 对象", "Field must output an effects JSON object"],
    focus: ["每次更新时定位当前对象", "Focuses this object on every update"],
    label: ["字段值更新标注文字", "Field value updates annotation text"]
  };
  return hints[action][locale === "zh-CN" ? 0 : 1];
}

function productKey(kind: "dataset" | "pipeline", id: string): string { return `${kind}:${id}`; }
function errorMessage(reason: unknown): string { return reason instanceof Error ? reason.message : "数据预览失败"; }
function formatValue(value: unknown): string {
  if (value === undefined) return "—";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 48 ? `${text.slice(0, 45)}…` : text;
}
function withoutKey<T>(source: Record<string, T>, key: string): Record<string, T> { const next = { ...source }; delete next[key]; return next; }
