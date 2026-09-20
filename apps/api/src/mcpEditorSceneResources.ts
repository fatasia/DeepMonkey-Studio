import type { ApplicationDocument, SceneDocument } from "@bim-studio/contracts";
import type { EditorPresence } from "./editorPresence.js";
import { activeDraftMirror, type EditorSceneDraftMirror } from "./editorSceneDraftMirror.js";
import type { MetadataStore } from "./store.js";

const PAGE_SIZE = 50;
const KINDS = ["scene-objects", "selection-sets", "spatial-relations"] as const;
type SceneResourceKind = typeof KINDS[number];

export interface EditorSceneResourceAddress {
  sessionId: string;
  draftRevision: number;
  persistedRevision: number;
  kind: SceneResourceKind;
  page: number;
}

export function listEditorSceneResources(entry: EditorPresence, store: MetadataStore) {
  const mirror = activeDraftMirror(entry);
  const source = resolveSource(entry, store);
  if (!mirror && !source) return [];
  return KINDS.flatMap(kind => {
    const items = mirror ? mirrorItems(mirror, kind) : resourceItems(source!.application, source!.scene, kind);
    const count = items.length;
    const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
    return Array.from({ length: pages }, (_, page) => descriptor(entry, kind, page, count, Boolean(mirror)));
  });
}

export function readEditorSceneResource(
  address: EditorSceneResourceAddress,
  entry: EditorPresence,
  store: MetadataStore,
): { uri: string; mimeType: string; text: string } | undefined {
  if (entry.surface !== "scene" || entry.draftRevision !== address.draftRevision
    || entry.persistedRevision !== address.persistedRevision) return undefined;
  // 未保存草稿镜像：只有当镜像的 scene/revision 与 presence 当前值完全一致时才可信；
  // 任何漂移都回退持久化基线并明确标注，revision 失配本身仍然 404（上面的守卫）。
  const mirror = activeDraftMirror(entry);
  const persisted = resolveSource(entry, store);
  if (!mirror && !persisted) return undefined;
  const sceneId = mirror?.sceneId ?? persisted!.scene.id;
  const items = mirror ? mirrorItems(mirror, address.kind) : resourceItems(persisted!.application, persisted!.scene, address.kind);
  const offset = address.page * PAGE_SIZE;
  if (address.page < 0 || (items.length > 0 && offset >= items.length)) return undefined;
  const uri = sceneResourceUri(entry, address.kind, address.page);
  const nextPage = offset + PAGE_SIZE < items.length ? address.page + 1 : undefined;
  return {
    uri,
    mimeType: "application/json",
    text: JSON.stringify({
      schema: "deep-monkey.editor-scene-resource.v1",
      kind: address.kind,
      sessionId: entry.sessionId,
      projectId: entry.projectId,
      applicationId: entry.applicationId,
      sceneId,
      persistedRevision: entry.persistedRevision,
      activeDraftRevision: entry.draftRevision,
      draftDirty: entry.dirty,
      source: mirror ? "browser-draft-mirror" : "persisted-editor-base",
      ...(mirror ? {} : { draftMirrorState: draftMirrorState(entry) }),
      page: address.page,
      pageSize: PAGE_SIZE,
      total: items.length,
      ...(nextPage === undefined ? {} : { nextUri: sceneResourceUri(entry, address.kind, nextPage) }),
      items: items.slice(offset, offset + PAGE_SIZE),
    }),
  };
}

/** dirty 但镜像缺失/漂移时的诚实标注；未 dirty 时不标注（镜像本就不该存在）。 */
function draftMirrorState(entry: EditorPresence): "unavailable" | "stale" {
  const mirror = entry.draftMirror;
  return mirror && mirror.sceneId === entry.targetId && mirror.revision !== entry.draftRevision ? "stale" : "unavailable";
}

export function parseEditorSceneResourceUri(value: unknown): EditorSceneResourceAddress | undefined {
  if (typeof value !== "string") return undefined;
  let parsed: URL;
  try { parsed = new URL(value); } catch { return undefined; }
  const segments = parsed.pathname.split("/").filter(Boolean).map(segment => {
    try { return decodeURIComponent(segment); } catch { return ""; }
  });
  const draftRevision = Number(parsed.searchParams.get("revision"));
  const persistedRevision = Number(parsed.searchParams.get("persistedRevision"));
  const page = Number(parsed.searchParams.get("page"));
  const kind = segments[2];
  if (parsed.protocol !== "studio:" || parsed.hostname !== "active-editor"
    || segments.length !== 3 || segments[1] !== "scene-context" || !isKind(kind)
    || !safeRevision(draftRevision) || !safeRevision(persistedRevision) || !safeRevision(page)) return undefined;
  return { sessionId: segments[0]!, draftRevision, persistedRevision, kind, page };
}

function descriptor(entry: EditorPresence, kind: SceneResourceKind, page: number, total: number, mirrorActive: boolean) {
  const labels: Record<SceneResourceKind, string> = {
    "scene-objects": "场景语义对象",
    "selection-sets": "选择集",
    "spatial-relations": "空间关系",
  };
  const mirrorNote = mirrorActive ? "；当前读取未保存草稿镜像" : entry.dirty ? "；未保存草稿镜像不可用，读取持久化基线" : "";
  return {
    uri: sceneResourceUri(entry, kind, page),
    name: `editor-${entry.sessionId}-${kind}-${page}`,
    title: `${entry.targetName ?? entry.applicationName} · ${labels[kind]} · ${page + 1}`,
    description: `持久化 revision ${entry.persistedRevision}；活跃草稿 revision ${entry.draftRevision}${entry.dirty ? "（草稿有未保存修改）" : ""}${mirrorNote}；共 ${total} 项`,
    mimeType: "application/json",
  };
}

function sceneResourceUri(entry: EditorPresence, kind: SceneResourceKind, page: number): string {
  return `studio://active-editor/${encodeURIComponent(entry.sessionId)}/scene-context/${kind}`
    + `?revision=${entry.draftRevision}&persistedRevision=${entry.persistedRevision}&page=${page}`;
}

function resolveSource(entry: EditorPresence, store: MetadataStore): { application: ApplicationDocument; scene: SceneDocument } | undefined {
  if (entry.surface !== "scene" || !entry.targetId) return undefined;
  const application = store.getApplication(entry.projectId, entry.applicationId);
  if (!application || application.metadata.revision !== entry.persistedRevision) return undefined;
  const scene = application.scenes.find(candidate => candidate.id === entry.targetId);
  return scene ? { application, scene } : undefined;
}

function resourceItems(application: ApplicationDocument, scene: SceneDocument, kind: SceneResourceKind): readonly unknown[] {
  if (kind === "selection-sets") return (scene.selectionSets ?? []).map(set => ({
    id: set.id, name: set.name, kind: set.kind ?? "selection", objectIds: [...set.objectIds],
  }));
  if (kind === "spatial-relations") return (application.spatialNavigation?.nodes ?? []).map(node => ({
    id: node.id, name: node.name, kind: node.kind, ...(node.parentId ? { parentId: node.parentId } : {}),
    ...(node.sceneId ? { sceneId: node.sceneId } : {}),
    ...(node.dashboardPageId ? { dashboardPageId: node.dashboardPageId } : {}),
    ...(node.target ? { target: { ...node.target } } : {}), loadPolicy: node.loadPolicy,
  }));
  return [
    ...scene.models.map(model => objectSummary(model, "model")),
    ...scene.primitives.map(primitive => objectSummary(primitive, `primitive:${primitive.kind}`)),
  ];
}

/** 草稿镜像条目与持久化条目共用同一 item 形状，读取方无需区分来源结构。 */
function mirrorItems(mirror: EditorSceneDraftMirror, kind: SceneResourceKind): readonly unknown[] {
  if (kind === "selection-sets") return mirror.selectionSets.map(set => ({
    id: set.id, name: set.name, kind: set.kind ?? "selection", objectIds: [...set.objectIds],
  }));
  if (kind === "spatial-relations") return mirror.spatialRelations.map(node => ({
    id: node.id, name: node.name, kind: node.kind, ...(node.parentId ? { parentId: node.parentId } : {}),
    ...(node.sceneId ? { sceneId: node.sceneId } : {}),
    ...(node.dashboardPageId ? { dashboardPageId: node.dashboardPageId } : {}),
    ...(node.target ? { target: { ...node.target } } : {}), loadPolicy: node.loadPolicy,
  }));
  return mirror.objects.map(object => ({
    objectId: object.objectId, name: object.name, kind: object.kind,
    assetModelId: object.assetModelId ?? object.objectId, visible: object.visible, locked: object.locked,
    layers: (object.layers ?? []).map(layer => ({ id: layer.id, name: layer.name ?? layer.id, visible: layer.visible })),
  }));
}

function objectSummary(model: SceneDocument["models"][number], kind: string) {
  return {
    objectId: model.modelId, name: model.name, kind,
    assetModelId: model.assetModelId ?? model.modelId, visible: model.visible, locked: model.locked ?? false,
    layers: (model.layers ?? []).map(layer => ({
      id: layer.nodeId, name: layer.name ?? layer.nodeId, visible: layer.visible ?? true,
    })),
  };
}

function isKind(value: string | undefined): value is SceneResourceKind {
  return KINDS.includes(value as SceneResourceKind);
}
function safeRevision(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
