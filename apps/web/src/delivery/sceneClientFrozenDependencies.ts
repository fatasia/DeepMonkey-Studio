import type { PublishedSceneRecord, ScenePublicationDependencies } from "@bim-studio/contracts";
import { api } from "../api";

/** 完整发布身份与服务端一致；不能用仅场景编译源的 hash 替代。 */
export async function scenePublicationDependencyIdentity(publication: PublishedSceneRecord): Promise<string> {
  const value: unknown = JSON.parse(JSON.stringify({ projectId: publication.projectId, sceneId: publication.sceneId,
    version: publication.version, publishedAt: publication.publishedAt, snapshot: publication.snapshot }, (_key, item: unknown) => {
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error("发布内容包含非有限数值");
    if (["function", "symbol", "bigint"].includes(typeof item)) throw new Error("发布内容不是 JSON");
    return item;
  }));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function loadFrozenSceneClientDependencies(publication: PublishedSceneRecord, signal: AbortSignal): Promise<ScenePublicationDependencies> {
  const source = structuredClone(publication);
  signal.throwIfAborted();
  if (!Number.isSafeInteger(source.version) || source.version! < 1) throw new Error("该历史版本没有冻结的发布依赖，请重新发布后打包。");
  const result = await api.getScenePublicationDependencies(source.projectId, source.sceneId, source.version!, signal);
  signal.throwIfAborted();
  if (!result) throw new Error("该历史版本没有冻结的发布依赖，请重新发布后打包。");
  const record = structuredClone(result);
  const identity = await scenePublicationDependencyIdentity(source);
  signal.throwIfAborted();
  if (record.schemaVersion !== 1 || record.projectId !== source.projectId || record.sceneId !== source.sceneId
    || record.version !== source.version || record.publishedAt !== source.publishedAt || record.publicationIdentity !== identity
    || source.snapshot.projectId !== source.projectId || source.snapshot.id !== source.sceneId
    || record.inputs.project.id !== source.projectId) throw new Error("冻结依赖与发布版本不一致。");
  const expected = new Map(record.inputs.resources.map(item => [item.url, item]));
  if (expected.size !== record.inputs.resources.length || expected.size !== record.resources.length) throw new Error("冻结资源缺失或重复。");
  const seen = new Set<string>();
  for (const resource of record.resources) {
    const input = expected.get(resource.sourceUrl);
    if (!input || seen.has(resource.sourceUrl) || !/^[a-f0-9]{64}$/.test(resource.sha256)
      || !Number.isSafeInteger(resource.bytes) || resource.bytes < 0
      || resource.key !== `projects/${source.projectId}/publication-resources/sha256/${resource.sha256}`) throw new Error("冻结资源描述无效。");
    seen.add(resource.sourceUrl);
    const integrity = `sha256-${btoa(String.fromCharCode(...resource.sha256.match(/../g)!.map(byte => parseInt(byte, 16))))}`;
    for (const claim of input.claims) if ((claim.bytes !== undefined && claim.bytes !== resource.bytes)
      || (claim.sha256 !== undefined && claim.sha256 !== resource.sha256)
      || (claim.integrity !== undefined && claim.integrity !== integrity)) throw new Error("冻结资源与声明不一致。");
  }
  assertFrozenNativeCompiled(record);
  return record;
}

export function assertFrozenNativeCompiled(record: ScenePublicationDependencies): void {
  if (record.nativeCompiled === undefined) return;
  const native = record.nativeCompiled;
  const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (!native || !native.runtimePackage || !native.compilationEvidence || !native.compatibilityReport) throw new Error("冻结 Native 编译描述无效");
  const { runtimePackage: runtime, compilationEvidence: evidence, compatibilityReport: report } = native;
  if (!hash(runtime.sha256) || runtime.key !== `projects/${record.projectId}/publication-resources/sha256/${runtime.sha256}`
    || !Number.isSafeInteger(runtime.bytes) || runtime.bytes < 1 || runtime.bytes > 256 * 1024 ** 2
    || !hash(native.compilerSha256) || !hash(native.executableSha256) || !Number.isFinite(Date.parse(native.verifiedAt))
    || report.schemaVersion !== 1 || report.target !== "deep-native" || report.status !== "ready" || report.sceneId !== record.sceneId
    || report.platform !== "windows-x64" || !hash(evidence.sourceSemanticHash) || !hash(evidence.compileGraphHash)
    || report.contentFingerprint !== evidence.sourceSemanticHash || report.compileGraphHash !== evidence.compileGraphHash
    || report.targetArtifactHash !== runtime.sha256 || evidence.targetArtifactHash !== runtime.sha256
    || report.fixtureId !== `scene-${evidence.sourceSemanticHash}`) throw new Error("冻结 Native 编译身份不一致");
}

export function frozenSceneResourceUrl(record: ScenePublicationDependencies, sha: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha) || (!record.resources.some(resource => resource.sha256 === sha)
    && record.nativeCompiled?.runtimePackage.sha256 !== sha)) throw new Error("资源不属于该发布版本。");
  return `/api/projects/${encodeURIComponent(record.projectId)}/scenes/${encodeURIComponent(record.sceneId)}/publications/${record.version}/dependencies/resources/${sha}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
