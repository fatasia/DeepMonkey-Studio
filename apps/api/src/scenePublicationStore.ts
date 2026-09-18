import { matchesSceneDependencyCapture, bindScenePublicationDependencies, readScenePublicationDependencies, retainScenePublicationDependencies } from "./scenePublicationDependencyStore.js";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseDocument, PublishedSceneRecord } from "@bim-studio/contracts";
import type { PublishSceneSnapshotInput, PublishSceneSnapshotResult, RestoreScenePublicationInput, RestoreScenePublicationResult } from "./metadataStore.js";
import { assertSceneAssetReferences } from "./modelAssetReferences.js";
import { withCurrentScenePublication } from "./scenePublicationHistory.js";
import { changed, unchanged, type DocumentMutation } from "./storeUtils.js";

/** 冻结发布请求并绑定排队取消；持久化开始后不再撤销已经提交的事务。 */
export function prepareScenePublicationMutation(input: PublishSceneSnapshotInput, signal?: AbortSignal) {
  const expected = structuredClone(input);
  signal?.throwIfAborted();
  return (candidate: DatabaseDocument): DocumentMutation<PublishSceneSnapshotResult> => {
    signal?.throwIfAborted();
    return publishSceneSnapshotMutation(candidate, expected);
  };
}

/** 按 JSON 传输内容比较：对象键顺序无关，数组顺序保留，undefined 属性不构成冲突。 */
export function scenePublicationJsonEqual(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown): unknown => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  return isDeepStrictEqual(normalize(left), normalize(right));
}

/** 仅修改事务候选副本，由存储层负责一次持久化和提交。 */
export function publishSceneSnapshotMutation(document: DatabaseDocument, input: PublishSceneSnapshotInput): DocumentMutation<PublishSceneSnapshotResult> {
  const index = document.scenes.findIndex((scene) => scene.projectId === input.projectId && scene.id === input.sceneId);
  if (index < 0) return unchanged({ status: "scene-not-found" });
  const source = document.scenes[index]!;
  if (!scenePublicationJsonEqual(source, input.expectedSnapshot)) return unchanged({ status: "snapshot-conflict" });
  const current = document.publishedScenes?.find((publication) => publication.sceneId === input.sceneId);
  if (!scenePublicationJsonEqual(current, input.expectedPublication)) return unchanged({ status: "publication-conflict" });
  if (!Number.isFinite(Date.parse(input.publishedAt))) throw new Error("发布时间无效");
  if (input.dependencyCapture && !matchesSceneDependencyCapture(document, source, input.dependencyCapture)) return unchanged({ status: "dependency-conflict" });
  const snapshot = { ...structuredClone(source), publishedAt: input.publishedAt, updatedAt: input.publishedAt };
  const publication = appendScenePublication(document, {
    projectId: source.projectId, sceneId: source.id, name: source.name, snapshot, publishedAt: input.publishedAt,
  });
  if (input.dependencyCapture) bindScenePublicationDependencies(document, publication, input.dependencyCapture);
  document.scenes[index] = snapshot;
  return changed({ status: "published", publication });
}

/** 恢复只同步草稿的发布设置；历史、线上版本与草稿元数据必须一次提交。 */
export function restoreScenePublicationMutation(document: DatabaseDocument, input: RestoreScenePublicationInput): DocumentMutation<RestoreScenePublicationResult> {
  const index = document.scenes.findIndex(scene => scene.projectId === input.projectId && scene.id === input.sceneId);
  if (index < 0) return unchanged({ status: "scene-not-found" });
  const draft = document.scenes[index]!;
  if (!scenePublicationJsonEqual(draft, input.expectedSnapshot)) return unchanged({ status: "snapshot-conflict" });
  const current = document.publishedScenes?.find(item => item.sceneId === input.sceneId);
  if (!scenePublicationJsonEqual(current, input.expectedPublication)) return unchanged({ status: "publication-conflict" });
  const candidates = withCurrentScenePublication(document.scenePublicationHistory ?? [], current)
    .filter(item => item.projectId === input.projectId && item.sceneId === input.sceneId
      && item.publishedAt === input.historicalPublication.publishedAt);
  if (candidates.length !== 1 || !scenePublicationJsonEqual(candidates[0], input.historicalPublication)) {
    return unchanged({ status: "history-conflict" });
  }
  const historical = candidates[0]!;
  if (historical.snapshot.projectId !== input.projectId || historical.snapshot.id !== input.sceneId) {
    return unchanged({ status: "history-conflict" });
  }
  if (!Number.isFinite(Date.parse(input.publishedAt))) throw new Error("发布时间无效");
  let dependencies;
  try {
    dependencies = historical.version === undefined ? undefined : readScenePublicationDependencies(document, input.projectId, input.sceneId, historical.version);
  } catch { return unchanged({ status: "history-conflict" }); }
  const publication = appendScenePublication(document, { ...structuredClone(historical), publishedAt: input.publishedAt,
    snapshot: { ...structuredClone(historical.snapshot), publishedAt: input.publishedAt, updatedAt: input.publishedAt } });
  if (dependencies) bindScenePublicationDependencies(document, publication, { inputs: dependencies.inputs, resources: dependencies.resources,
    ...(dependencies.nativeCompiled ? { nativeCompiled: dependencies.nativeCompiled } : {}) });
  document.scenes[index] = { ...draft, publishedAt: input.publishedAt,
    publicationMode: historical.snapshot.publicationMode ?? "webgl",
    publicationPerformance: historical.snapshot.publicationPerformance ?? "standard",
    publicationToolbarVisible: historical.snapshot.publicationToolbarVisible !== false };
  return changed({ status: "restored", publication });
}

/** 统一正式发布与历史兼容写入的版本编号、历史保留和资产约束。 */
export function appendScenePublication(document: DatabaseDocument, publication: PublishedSceneRecord): PublishedSceneRecord {
  assertSceneAssetReferences(document, publication.projectId, [publication.snapshot]);
  document.publishedScenes ??= [];
  const current = document.publishedScenes.find((item) => item.sceneId === publication.sceneId);
  document.scenePublicationHistory = withCurrentScenePublication(document.scenePublicationHistory ?? [], current);
  const history = document.scenePublicationHistory.filter((item) => item.sceneId === publication.sceneId);
  const version = Math.max(history.length, ...history.map((item) => item.version ?? 0)) + 1;
  const versioned: PublishedSceneRecord = { ...structuredClone(publication), version };
  const index = document.publishedScenes.findIndex((item) => item.sceneId === publication.sceneId);
  if (index >= 0) document.publishedScenes[index] = versioned;
  else document.publishedScenes.push(versioned);
  document.scenePublicationHistory.push(structuredClone(versioned));
  const recent = document.scenePublicationHistory.filter((item) => item.sceneId === publication.sceneId)
    .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt)).slice(0, 50);
  document.scenePublicationHistory = document.scenePublicationHistory.filter((item) => item.sceneId !== publication.sceneId).concat(recent);
  retainScenePublicationDependencies(document);
  return structuredClone(versioned);
}
