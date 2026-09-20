import type { ApplicationDocument } from "@bim-studio/contracts";

/**
 * 活跃编辑器未保存草稿的语义快照（镜像载荷）。结构必须与 API 侧
 * `apps/api/src/editorSceneDraftMirror.ts` 的校验保持一致：全有或全无，
 * 超过任一上限就整体不发送（API 侧 fail-closed 到 persisted-editor-base），
 * 绝不发送半个"真相"。
 */
export interface EditorSceneDraftMirrorPayload {
  sceneId: string;
  revision: number;
  objects: Array<{
    objectId: string;
    name: string;
    kind: string;
    assetModelId?: string;
    visible: boolean;
    locked: boolean;
    layers?: Array<{ id: string; name?: string; visible: boolean }>;
  }>;
  selectionSets: Array<{ id: string; name: string; kind?: string; objectIds: string[] }>;
  spatialRelations: Array<{
    id: string;
    name: string;
    kind: string;
    parentId?: string;
    sceneId?: string;
    dashboardPageId?: string;
    target?: { modelId?: string; dashboardPageId?: string };
    loadPolicy: string;
  }>;
}

const LIMITS = { objects: 2000, selectionSets: 200, spatialRelations: 1000 } as const;

/**
 * 从浏览器内存中的草稿文档提取活跃场景快照。只读活跃 scene 的三类语义
 * （对象、选择集、空间关系），与 MCP 场景资源的 item 形状对齐；
 * 空间关系是应用级节点，整体随场景快照带回。
 */
export function buildEditorSceneDraftSnapshot(
  document: ApplicationDocument,
  sceneId: string,
  revision: number,
): EditorSceneDraftMirrorPayload | undefined {
  const scene = document.scenes.find(candidate => candidate.id === sceneId);
  if (!scene) return undefined;
  const objects = [...scene.models, ...scene.primitives];
  if (objects.length > LIMITS.objects || (scene.selectionSets?.length ?? 0) > LIMITS.selectionSets
    || (document.spatialNavigation?.nodes.length ?? 0) > LIMITS.spatialRelations) {
    return undefined;
  }
  return {
    sceneId,
    revision,
    objects: objects.map(model => ({
      objectId: model.modelId,
      name: model.name,
      kind: "kind" in model && model.kind ? `primitive:${model.kind}` : "model",
      ...(model.assetModelId ? { assetModelId: model.assetModelId } : {}),
      visible: model.visible,
      locked: model.locked ?? false,
      ...(model.layers?.length ? {
        layers: model.layers.map(layer => ({
          id: layer.nodeId, ...(layer.name ? { name: layer.name } : {}), visible: layer.visible ?? true,
        })),
      } : {}),
    })),
    selectionSets: (scene.selectionSets ?? []).map(set => ({
      id: set.id, name: set.name, ...(set.kind ? { kind: set.kind } : {}), objectIds: [...set.objectIds],
    })),
    spatialRelations: (document.spatialNavigation?.nodes ?? []).map(node => ({
      id: node.id, name: node.name, kind: node.kind,
      ...(node.parentId ? { parentId: node.parentId } : {}),
      ...(node.sceneId ? { sceneId: node.sceneId } : {}),
      ...(node.dashboardPageId ? { dashboardPageId: node.dashboardPageId } : {}),
      ...(node.target ? { target: { ...node.target } } : {}),
      loadPolicy: node.loadPolicy,
    })),
  };
}
