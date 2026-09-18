import type { DatabaseDocument } from "@bim-studio/contracts";
import type { DiscardSceneInput, DiscardSceneResult } from "./metadataStore.js";
import { scenePublicationJsonEqual } from "./scenePublicationStore.js";
import { withCurrentScenePublication } from "./scenePublicationHistory.js";
import { changed, unchanged, type DocumentMutation } from "./storeUtils.js";

/** 云会话停止后再次核对原版本，避免迟到撤回或删除作用于另一次保存/发布。 */
export function discardSceneMutation(document: DatabaseDocument, input: DiscardSceneInput): DocumentMutation<DiscardSceneResult> {
  if (input.action !== "unpublish" && input.action !== "delete") throw new Error("场景移除操作无效");
  const draft = document.scenes.find(scene => scene.projectId === input.projectId && scene.id === input.sceneId);
  if (!draft) return unchanged({ status: "scene-not-found" });
  if (!scenePublicationJsonEqual(draft, input.expectedSnapshot)) return unchanged({ status: "snapshot-conflict" });
  const publication = document.publishedScenes?.find(item => item.sceneId === input.sceneId);
  if ((publication && publication.projectId !== input.projectId)
    || !scenePublicationJsonEqual(publication, input.expectedPublication)) return unchanged({ status: "publication-conflict" });
  if (input.action === "unpublish") {
    if (!publication) return unchanged({ status: "not-published" });
    removeScenePublication(document, input.sceneId);
  } else removeSceneDocuments(document, input.projectId, input.sceneId);
  return changed({ status: "discarded" });
}

/** 共享清理语义：删除场景连同其发布历史，只作用于指定项目。 */
export function removeSceneDocuments(document: DatabaseDocument, projectId: string, sceneId: string): boolean {
  const index = document.scenes.findIndex(scene => scene.projectId === projectId && scene.id === sceneId);
  if (index < 0) return false;
  document.scenes.splice(index, 1);
  document.scenePublicationDependencies = (document.scenePublicationDependencies ?? []).filter(item => item.projectId !== projectId || item.sceneId !== sceneId);
  document.publishedScenes = (document.publishedScenes ?? []).filter(item => item.projectId !== projectId || item.sceneId !== sceneId);
  document.scenePublicationHistory = (document.scenePublicationHistory ?? []).filter(item => item.projectId !== projectId || item.sceneId !== sceneId);
  return true;
}

/** 撤回保留历史与草稿，只清除草稿的发布标记。 */
export function removeScenePublication(document: DatabaseDocument, sceneId: string): boolean {
  const current = document.publishedScenes?.find(item => item.sceneId === sceneId);
  if (!current) return false;
  document.publishedScenes = document.publishedScenes!.filter(item => item.sceneId !== sceneId || item.projectId !== current.projectId);
  document.scenePublicationHistory = withCurrentScenePublication(document.scenePublicationHistory ?? [], current);
  const scene = document.scenes.find(item => item.id === sceneId && item.projectId === current.projectId);
  if (scene) delete scene.publishedAt;
  return true;
}
