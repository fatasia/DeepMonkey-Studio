import { createHash } from "node:crypto";
import type { MetadataStore } from "./metadataStore.js";
import type { ObjectStore } from "./objects.js";
import type { ClientPackageBranding } from "./clientPackageBranding.js";
import { assertCapturedSceneDependencies } from "./scenePublicationDependencyStore.js";
import { assessVerifiedNativeSceneCandidate } from "./nativeSceneCandidateCompiler.js";
import { embedVerifiedNativeArtifact } from "./nativeStandaloneExecutable.js";

export interface SceneExecutableDependencies {
  store: MetadataStore; objects: ObjectStore; nativeExecutable?: string;
  assess?: typeof assessVerifiedNativeSceneCandidate;
}

/** A download consumes the immutable publication, never a new draft or a second candidate registry. */
export async function createSceneStandaloneExecutable(deps: SceneExecutableDependencies,
  input: { projectId: string; sceneId: string; version: number; branding?: ClientPackageBranding; signal: AbortSignal }) {
  const { projectId, sceneId, version, signal } = input;
  signal.throwIfAborted();
  const get = () => {
    const record = deps.store.getScenePublicationDependencies(projectId, sceneId, version);
    if (!record?.nativeCompiled || record.projectId !== projectId || record.sceneId !== sceneId || record.version !== version) {
      throw new Error("该发布版本没有已验证 Native 产物，请重新验证并发布");
    }
    assertCapturedSceneDependencies(projectId, record, sceneId);
    return structuredClone(record);
  };
  const record = get(), native = record.nativeCompiled!;
  const publications = deps.store.listScenePublications(sceneId).filter(item => item.projectId === projectId && item.sceneId === sceneId
    && item.version === version && item.publishedAt === record.publishedAt);
  if (publications.length !== 1) throw new Error("无法唯一定位原发布版本");
  const publication = structuredClone(publications[0]!);
  const resource = native.runtimePackage;
  const artifact = await readFrozenResource(deps.objects, resource, signal, 256 * 1024 ** 2, "Native 资源");
  const executable = native.executable
    ? await readFrozenResource(deps.objects, native.executable, signal, 512 * 1024 ** 2, "Native 程序")
    : deps.nativeExecutable;
  if (!executable) throw new Error("该旧发布版本没有冻结 Native 程序，且服务未配置兼容程序，请重新验证并发布");
  const report = await (deps.assess ?? assessVerifiedNativeSceneCandidate)({ scene: publication.snapshot,
    compiled: { packageJson: new TextDecoder("utf-8", { fatal: true }).decode(artifact), evidence: native.compilationEvidence,
      compilerSha256: native.compilerSha256, report: native.compatibilityReport },
    runtimeEvidence: native.compatibilityReport.evidence, signal });
  if (report.status === "blocked" || report.targetArtifactHash !== resource.sha256) throw new Error("冻结 Native 发布证据未通过复核");
  let bytes: Uint8Array;
  try {
    bytes = await embedVerifiedNativeArtifact(artifact, executable,
      { signal, expectedSha256: native.executableSha256, ...(input.branding ? { branding: input.branding } : {}) });
  } catch (reason) {
    if (reason instanceof Error && reason.message.includes("changed since deployment")) throw new Error("Native 程序与原窗口验证 SHA 不一致，请重新验证并发布");
    throw reason;
  }
  signal.throwIfAborted();
  if (JSON.stringify(get()) !== JSON.stringify(record)) throw new Error("发布版本在打包期间变化，请重试原版本");
  return { bytes, publication, artifactSha256: resource.sha256 };
}

async function readFrozenResource(objects: ObjectStore, resource: { key: string; bytes: number; sha256: string },
  signal: AbortSignal, maxBytes: number, label: string): Promise<Buffer> {
  if (!Number.isSafeInteger(resource.bytes) || resource.bytes < 1 || resource.bytes > maxBytes) throw new Error(`${label}超出字节预算`);
  const source = await objects.read(resource.key), chunks: Buffer[] = [];
  let rejectAbort!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  void cancelled.catch(() => undefined);
  const abort = () => { source.stream.destroy(signal.reason instanceof Error ? signal.reason : new Error("下载已取消")); rejectAbort(signal.reason); };
  signal.addEventListener("abort", abort, { once: true });
  const completed = source.completed.catch(reason => { source.stream.destroy(reason instanceof Error ? reason : new Error("冻结资源读取失败")); throw reason; });
  // Observe adapter failures even while its stream is pending.
  void completed.catch(() => undefined);
  let size = 0;
  try {
    signal.throwIfAborted();
    for await (const chunk of source.stream) {
      signal.throwIfAborted(); const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > resource.bytes || size > maxBytes) throw new Error(`${label}超出字节预算`);
      chunks.push(bytes);
    }
    await Promise.race([completed, cancelled]); signal.throwIfAborted();
  } finally { signal.removeEventListener("abort", abort); source.stream.destroy(); }
  const content = Buffer.concat(chunks, size);
  if (size !== resource.bytes || createHash("sha256").update(content).digest("hex") !== resource.sha256) throw new Error(`${label}字节身份不匹配`);
  return content;
}
