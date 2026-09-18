import { isDeepStrictEqual } from "node:util";
import { assertPathSafeResourceId, summarizeScenePublicationCompatibility, type DatabaseDocument, type PublishedSceneRecord,
  type SceneNativeCompiledPublication, type ScenePublicationDependencies, type SceneSnapshot } from "@bim-studio/contracts";
import { selectSceneClientDependencyInputs } from "@bim-studio/studio-core";
import type { CapturedScenePublicationDependencies } from "./metadataStore.js";
import { cloudRenderPublicationIdentity } from "./cloudRenderPublicationIdentity.js";
import { withCurrentScenePublication } from "./scenePublicationHistory.js";

/** 只验证持久化描述；字节读取及不可变写入由捕获服务完成。 */
export function assertCapturedSceneDependencies(projectId: string, capture: CapturedScenePublicationDependencies, sceneId?: string): void {
  assertPathSafeResourceId(projectId, "projectId");
  if (capture.inputs.project.id !== projectId) throw new Error("发布依赖项目不匹配");
  if (capture.nativeCompiled !== undefined) assertNativeCompiled(projectId, capture.nativeCompiled, sceneId);
  const expected = new Map(capture.inputs.resources.map(item => [item.url, item]));
  if (expected.size !== capture.inputs.resources.length || capture.resources.length !== expected.size) throw new Error("发布依赖资源缺失或重复");
  const seen = new Set<string>();
  for (const resource of capture.resources) {
    const input = expected.get(resource.sourceUrl);
    if (!input || seen.has(resource.sourceUrl) || !/^[a-f0-9]{64}$/.test(resource.sha256)
      || !Number.isSafeInteger(resource.bytes) || resource.bytes < 0
      || resource.key !== `projects/${projectId}/publication-resources/sha256/${resource.sha256}`) throw new Error("发布依赖资源描述无效");
    seen.add(resource.sourceUrl);
    const integrity = `sha256-${Buffer.from(resource.sha256, "hex").toString("base64")}`;
    for (const claim of input.claims) {
      if ((claim.bytes !== undefined && claim.bytes !== resource.bytes)
        || (claim.sha256 !== undefined && claim.sha256 !== resource.sha256)
        || (claim.integrity !== undefined && claim.integrity !== integrity)) throw new Error("发布依赖资源与声明不一致");
    }
  }
}

export function matchesSceneDependencyCapture(document: DatabaseDocument, scene: SceneSnapshot, capture: CapturedScenePublicationDependencies): boolean {
  assertCapturedSceneDependencies(scene.projectId, capture, scene.id);
  const project = document.projects.find(item => item.id === scene.projectId);
  if (!project) return false;
  try {
    const inputs = selectSceneClientDependencyInputs(project, scene,
      (document.applications ?? []).filter(app => app.metadata.projectId === scene.projectId));
    return isDeepStrictEqual(JSON.parse(JSON.stringify(inputs)), JSON.parse(JSON.stringify(capture.inputs)));
  } catch { return false; }
}

export function bindScenePublicationDependencies(document: DatabaseDocument, publication: PublishedSceneRecord, capture: CapturedScenePublicationDependencies): void {
  assertCapturedSceneDependencies(publication.projectId, capture, publication.sceneId);
  if (capture.nativeCompiled && (publication.snapshot.id !== publication.sceneId || publication.snapshot.projectId !== publication.projectId)) throw new Error("Native 发布快照身份不匹配");
  if (!Number.isSafeInteger(publication.version) || publication.version! < 1) throw new Error("发布版本无效");
  document.scenePublicationDependencies ??= [];
  document.scenePublicationDependencies.push({ schemaVersion: 1, projectId: publication.projectId, sceneId: publication.sceneId,
    version: publication.version!, publishedAt: publication.publishedAt, publicationIdentity: cloudRenderPublicationIdentity(publication),
    inputs: structuredClone(capture.inputs), resources: structuredClone(capture.resources),
    ...(capture.nativeCompiled ? { nativeCompiled: structuredClone(capture.nativeCompiled) } : {}) });
}

export function readScenePublicationDependencies(document: DatabaseDocument, projectId: string, sceneId: string, version: number): ScenePublicationDependencies | undefined {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("发布版本无效");
  const records = (document.scenePublicationDependencies ?? []).filter(item => item.projectId === projectId && item.sceneId === sceneId && item.version === version);
  if (!records.length) return undefined;
  const current = document.publishedScenes?.find(item => item.projectId === projectId && item.sceneId === sceneId);
  const publications = withCurrentScenePublication(document.scenePublicationHistory ?? [], current)
    .filter(item => item.projectId === projectId && item.sceneId === sceneId && item.version === version);
  const record = records[0]!;
  if (records.length !== 1 || publications.length !== 1 || record.schemaVersion !== 1
    || record.publishedAt !== publications[0]!.publishedAt || record.publicationIdentity !== cloudRenderPublicationIdentity(publications[0]!)) throw new Error("发布依赖身份损坏或不唯一");
  assertCapturedSceneDependencies(projectId, record, sceneId);
  if (record.nativeCompiled && (publications[0]!.snapshot.id !== sceneId || publications[0]!.snapshot.projectId !== projectId)) throw new Error("Native 发布快照身份不匹配");
  return structuredClone(record);
}

export function retainScenePublicationDependencies(document: DatabaseDocument): void {
  const identities = new Set([...(document.publishedScenes ?? []), ...(document.scenePublicationHistory ?? [])].map(cloudRenderPublicationIdentity));
  document.scenePublicationDependencies = (document.scenePublicationDependencies ?? []).filter(item => identities.has(item.publicationIdentity));
}

/** 字节及源投影由服务端编译器校验；这里复核持久化描述的完整身份绑定。 */
function assertNativeCompiled(projectId: string, native: SceneNativeCompiledPublication, sceneId?: string): void {
  if (!native || typeof native !== "object") throw new Error("Native 编译产物描述无效");
  const validHash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const { runtimePackage: runtime, compilationEvidence: evidence, compatibilityReport: report } = native;
  if (!runtime || !evidence || !report || !validHash(native.compilerSha256) || !validHash(native.executableSha256)
    || typeof native.verifiedAt !== "string" || !Number.isFinite(Date.parse(native.verifiedAt))
    || !validHash(runtime.sha256) || !Number.isSafeInteger(runtime.bytes) || runtime.bytes < 1 || runtime.bytes > 256 * 1024 ** 2
    || runtime.key !== `projects/${projectId}/publication-resources/sha256/${runtime.sha256}`) throw new Error("Native 编译产物描述无效");
  if (report.schemaVersion !== 1 || report.target !== "deep-native" || report.status !== "ready" || report.platform !== "windows-x64"
    || (sceneId !== undefined && report.sceneId !== sceneId) || !report.sceneId?.trim()
    || !validHash(evidence.sourceSemanticHash) || !validHash(evidence.compileGraphHash) || !validHash(evidence.targetArtifactHash)
    || report.contentFingerprint !== evidence.sourceSemanticHash || report.compileGraphHash !== evidence.compileGraphHash
    || report.targetArtifactHash !== evidence.targetArtifactHash || runtime.sha256 !== evidence.targetArtifactHash
    || report.fixtureId !== `scene-${evidence.sourceSemanticHash}` || report.capabilityProfileVersion !== "deep-scene-compiled-v1") {
    throw new Error("Native 编译报告身份不匹配");
  }
  const capabilities = ["deep.scene.runtime.v1", "deep.scene.static-primitives.v1", "deep.scene.static-glb.v1", "deep.scene.camera.v1", "deep.scene.uncompiled.v1"];
  if (report.evidence.some(proof => proof.target !== report.target || proof.scope !== "native-window"
    || proof.platform !== report.platform || proof.fixtureId !== report.fixtureId || proof.sourceSemanticHash !== report.contentFingerprint
    || proof.compileGraphHash !== report.compileGraphHash || proof.targetArtifactHash !== report.targetArtifactHash)) throw new Error("Native 运行证据身份不匹配");
  for (const [capability, path] of [["deep.scene.runtime.v1", "$"], ["deep.scene.camera.v1", "camera"]]) {
    if (!report.items.some(item => item.capability === capability && item.path === path && item.objectId === report.sceneId)) throw new Error("Native 报告缺少必要检查项");
  }
  const checked = summarizeScenePublicationCompatibility({ ...report, profile: { version: report.capabilityProfileVersion, capabilities } });
  if (checked.status !== "ready") throw new Error("Native 运行证据未通过复核");
}
