import type { EditorPresence } from "./editorPresence.js";

/**
 * 浏览器活跃编辑器未保存草稿的镜像载荷。draft 内容本身只存在于浏览器内存；
 * presence 通道（已有轮询上报）把活跃 scene 的三类语义快照按需带回，进程内随
 * presence TTL 存活，永不落盘。全有或全无：任何一项越界/不合法即整体丢弃镜像，
 * 读取方回退 persisted-editor-base 并明确标注，绝不提供半个"真相"。
 */
export interface EditorSceneDraftMirror {
  readonly sceneId: string;
  /** 快照对应的草稿 revision；必须与 presence.draftRevision 一致才可信。 */
  readonly revision: number;
  readonly objects: readonly EditorDraftObjectMirror[];
  readonly selectionSets: readonly EditorDraftSelectionSetMirror[];
  readonly spatialRelations: readonly EditorDraftSpatialNodeMirror[];
}

export interface EditorDraftObjectMirror {
  readonly objectId: string;
  readonly name: string;
  readonly kind: string;
  readonly assetModelId?: string;
  readonly visible: boolean;
  readonly locked: boolean;
  readonly layers?: readonly { readonly id: string; readonly name?: string; readonly visible: boolean }[];
}

export interface EditorDraftSelectionSetMirror {
  readonly id: string;
  readonly name: string;
  readonly kind?: string;
  readonly objectIds: readonly string[];
}

export interface EditorDraftSpatialNodeMirror {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly parentId?: string;
  readonly sceneId?: string;
  readonly dashboardPageId?: string;
  readonly target?: { readonly modelId?: string; readonly dashboardPageId?: string };
  readonly loadPolicy: string;
}

export const DRAFT_MIRROR_LIMITS = {
  objects: 2000,
  selectionSets: 200,
  spatialRelations: 1000,
  objectId: 200,
  label: 240,
  layersPerObject: 64,
} as const;

/**
 * 校验浏览器上报的草稿镜像。返回 undefined 表示镜像不可信（缺字段、越界或结构
 * 不合法），调用方应丢弃镜像而不是截断或猜测；presence 摘要本身不受影响。
 */
export function parseEditorSceneDraftMirror(value: unknown): EditorSceneDraftMirror | undefined {
  if (!isRecord(value)) return undefined;
  const sceneId = value.sceneId;
  const revision = value.revision;
  if (!identifier(sceneId) || !safeRevision(revision)) return undefined;
  const objects = parseArray(value.objects, DRAFT_MIRROR_LIMITS.objects, parseObjectMirror);
  const selectionSets = parseArray(value.selectionSets, DRAFT_MIRROR_LIMITS.selectionSets, parseSelectionSetMirror);
  const spatialRelations = parseArray(value.spatialRelations, DRAFT_MIRROR_LIMITS.spatialRelations, parseSpatialNodeMirror);
  if (!objects || !selectionSets || !spatialRelations) return undefined;
  return { sceneId, revision, objects, selectionSets, spatialRelations };
}

/** 活跃编辑器 presence 上可用且 revision 一致的草稿镜像；任何漂移都返回 undefined。 */
export function activeDraftMirror(entry: EditorPresence): EditorSceneDraftMirror | undefined {
  const mirror = entry.draftMirror;
  if (!mirror || !entry.dirty) return undefined;
  if (mirror.revision !== entry.draftRevision || mirror.sceneId !== entry.targetId) return undefined;
  return mirror;
}

function parseArray<T>(value: unknown, limit: number, parseItem: (item: unknown) => T | undefined): readonly T[] | undefined {
  if (!Array.isArray(value) || value.length > limit) return undefined;
  const items: T[] = [];
  for (const candidate of value) {
    const item = parseItem(candidate);
    if (!item) return undefined;
    items.push(item);
  }
  return items;
}

function parseObjectMirror(value: unknown): EditorDraftObjectMirror | undefined {
  if (!isRecord(value) || !identifier(value.objectId) || !label(value.name) || typeof value.kind !== "string"
    || typeof value.visible !== "boolean" || typeof value.locked !== "boolean") return undefined;
  const layers = value.layers === undefined ? undefined : parseArray(value.layers, DRAFT_MIRROR_LIMITS.layersPerObject, layer => {
    if (!isRecord(layer) || !identifier(layer.id) || typeof layer.visible !== "boolean") return undefined;
    return { id: layer.id, ...(label(layer.name) ? { name: layer.name } : {}), visible: layer.visible };
  });
  return {
    objectId: value.objectId, name: value.name, kind: value.kind.slice(0, DRAFT_MIRROR_LIMITS.label),
    ...(identifier(value.assetModelId) ? { assetModelId: value.assetModelId } : {}),
    visible: value.visible, locked: value.locked, ...(layers ? { layers } : {}),
  };
}

function parseSelectionSetMirror(value: unknown): EditorDraftSelectionSetMirror | undefined {
  if (!isRecord(value) || !identifier(value.id) || !label(value.name) || !Array.isArray(value.objectIds)
    || value.objectIds.length > DRAFT_MIRROR_LIMITS.objects
    || !value.objectIds.every(id => typeof id === "string" && id.length > 0 && id.length <= DRAFT_MIRROR_LIMITS.objectId)) return undefined;
  return {
    id: value.id, name: value.name,
    ...(typeof value.kind === "string" ? { kind: value.kind.slice(0, DRAFT_MIRROR_LIMITS.label) } : {}),
    objectIds: [...value.objectIds],
  };
}

function parseSpatialNodeMirror(value: unknown): EditorDraftSpatialNodeMirror | undefined {
  if (!isRecord(value) || !identifier(value.id) || !label(value.name) || typeof value.kind !== "string"
    || typeof value.loadPolicy !== "string") return undefined;
  const target = isRecord(value.target)
    ? { ...(identifier(value.target.modelId) ? { modelId: value.target.modelId } : {}),
        ...(identifier(value.target.dashboardPageId) ? { dashboardPageId: value.target.dashboardPageId } : {}) }
    : undefined;
  return {
    id: value.id, name: value.name, kind: value.kind.slice(0, DRAFT_MIRROR_LIMITS.label),
    ...(identifier(value.parentId) ? { parentId: value.parentId } : {}),
    ...(identifier(value.sceneId) ? { sceneId: value.sceneId } : {}),
    ...(identifier(value.dashboardPageId) ? { dashboardPageId: value.dashboardPageId } : {}),
    ...(target && Object.keys(target).length > 0 ? { target } : {}),
    loadPolicy: value.loadPolicy.slice(0, DRAFT_MIRROR_LIMITS.label),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160;
}
function label(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= DRAFT_MIRROR_LIMITS.label;
}
function safeRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
