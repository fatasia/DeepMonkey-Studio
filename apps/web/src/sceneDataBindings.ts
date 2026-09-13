import { assertDirectBindingSpec, assertDeviceSignalRule, resolveDeviceSignal, type DataEventAction, type DataMessage, type DataPipelinePreview, type DataDatasetPreview, type SceneDataBindingState } from "@bim-studio/contracts";
import { normalizeMaterialDataPatch } from "./viewer/materialDataPatch";

export type DataProductPreview = Pick<DataDatasetPreview, "fields" | "rows"> | Pick<DataPipelinePreview, "fields" | "rows">;

const ACTIONS: readonly DataEventAction[] = ["color", "visibility", "position", "label", "opacity", "focus", "animation", "effects", "material", "alarm"];

export function normalizeSceneDataBindings(value: unknown): SceneDataBindingState[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Partial<SceneDataBindingState>;
    const target = item.target;
    if (!target || typeof target !== "object") return [];
    const modelId = typeof target.modelId === "string" && target.modelId.trim() ? target.modelId.trim() : undefined;
    const annotationId = typeof target.annotationId === "string" && target.annotationId.trim() ? target.annotationId.trim() : undefined;
    if (!modelId && !annotationId) return [];
    const datasetId = typeof item.datasetId === "string" && item.datasetId.trim() ? item.datasetId.trim() : undefined;
    const pipelineId = typeof item.pipelineId === "string" && item.pipelineId.trim() ? item.pipelineId.trim() : undefined;
    let directBinding = item.directBinding;
    if (directBinding) {
      try { assertDirectBindingSpec(directBinding); }
      catch { directBinding = undefined; }
    }
    if ([datasetId, pipelineId, directBinding].filter(Boolean).length !== 1) return [];
    if (typeof item.field !== "string" || !item.field.trim() || !ACTIONS.includes(item.action as DataEventAction)) return [];
    if (item.signalRule) { try { assertDeviceSignalRule(item.signalRule); } catch { return []; } }
    let id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `data-binding-${index}`;
    while (ids.has(id)) id = `${id}-${index}`;
    ids.add(id);
    return [{
      id,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 120) : item.field.trim(),
      enabled: item.enabled !== false,
      ...(datasetId ? { datasetId } : pipelineId ? { pipelineId } : { directBinding: structuredClone(directBinding!) }),
      field: item.field.trim(),
      rowIndex: clampInteger(item.rowIndex, 0, 999, 0),
      target: {
        ...(modelId ? { modelId } : {}),
        ...(modelId && typeof target.layerId === "string" && target.layerId.trim() ? { layerId: target.layerId.trim() } : {}),
        ...(annotationId ? { annotationId } : {})
      },
      action: item.action!,
      ...(item.signalRule ? {signalRule:structuredClone(item.signalRule)} : {}),
      refreshSeconds: clampInteger(item.refreshSeconds, 2, 3_600, 5)
    }];
  }).slice(0, 500);
}

export function directSceneDataBindingMessage(binding: SceneDataBindingState, value: unknown, sceneId: string, timestamp = new Date().toISOString()): DataMessage {
  if (!binding.directBinding) throw new Error("数据绑定缺少直接接口");
  return {
    source: `direct:${binding.id}`,
    key: binding.field,
    value: binding.action === "alarm" ? resolveDeviceSignal(value,binding.signalRule) : normalizeActionValue(binding.action, value),
    timestamp,
    sceneId,
    target: { ...binding.target },
    action: binding.action
  };
}

export function dataBindingProduct(binding: SceneDataBindingState): { kind: "dataset" | "pipeline"; id: string } {
  if (binding.pipelineId) return { kind: "pipeline", id: binding.pipelineId };
  if (binding.datasetId) return { kind: "dataset", id: binding.datasetId };
  throw new Error("数据绑定缺少数据产品");
}

export function sceneDataBindingMessage(binding: SceneDataBindingState, preview: DataProductPreview, sceneId: string, timestamp = new Date().toISOString()): DataMessage {
  const product = dataBindingProduct(binding);
  const row = preview.rows[binding.rowIndex ?? 0];
  if (!row) throw new Error("数据产品没有可绑定的数据行");
  if (!(binding.field in row)) throw new Error(`输出中不存在字段 ${binding.field}`);
  return {
    source: `${product.kind}:${product.id}`,
    key: binding.field,
    value: binding.action === "alarm" ? resolveDeviceSignal(row[binding.field],binding.signalRule) : normalizeActionValue(binding.action, row[binding.field]),
    timestamp,
    sceneId,
    target: { ...binding.target },
    action: binding.action
  };
}

export function sameDataBindingTarget(left: SceneDataBindingState["target"], right: SceneDataBindingState["target"]): boolean {
  return (left.modelId ?? "") === (right.modelId ?? "")
    && (left.layerId ?? "") === (right.layerId ?? "")
    && (left.annotationId ?? "") === (right.annotationId ?? "");
}

function normalizeActionValue(action: DataEventAction, value: unknown): unknown {
  if (action === "visibility" || action === "animation") return toBoolean(value);
  if (action === "opacity") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error("透明度字段必须是数字");
    return Math.max(0, Math.min(1, number));
  }
  if (action === "color") {
    if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error("颜色字段必须是 #RRGGBB");
    return value;
  }
  if (action === "position") {
    if (!value || typeof value !== "object") throw new Error("位置字段必须是包含 x、y、z 的对象");
    const vector = value as Record<string, unknown>;
    const x = Number(vector.x); const y = Number(vector.y); const z = Number(vector.z);
    if (![x, y, z].every(Number.isFinite)) throw new Error("位置字段必须是包含 x、y、z 的对象");
    return { x, y, z };
  }
  if (action === "effects" && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error("特效字段必须是 JSON 对象");
  if (action === "material") return normalizeMaterialDataPatch(value);
  if (action === "label") return typeof value === "string" ? value : JSON.stringify(value);
  return value;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["false", "0", "off", "no"].includes(normalized)) return false;
    if (["true", "1", "on", "yes"].includes(normalized)) return true;
  }
  return Boolean(value);
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.round(value))) : fallback;
}
