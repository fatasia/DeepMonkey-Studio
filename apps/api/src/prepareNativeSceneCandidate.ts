import { createHash } from "node:crypto";
import { getSceneModelAssetId, type SceneSnapshot } from "@bim-studio/contracts";
import { selectSceneClientDependencyInputs } from "@bim-studio/studio-core";
import type { MetadataStore } from "./metadataStore.js";
import type { ObjectStore } from "./objects.js";
import { captureScenePublicationDependencies } from "./scenePublicationDependencyCapture.js";
import { assertCapturedSceneDependencies } from "./scenePublicationDependencyStore.js";
import { scenePublicationJsonEqual } from "./scenePublicationStore.js";
import { compileNativeSceneCandidate } from "./nativeSceneCandidateCompiler.js";

/** 冻结输入后只读取私有内容地址；窗口验证与发布提交由上层分别执行。 */
export async function prepareNativeSceneCandidate(options: {
  store: MetadataStore; objects: ObjectStore; dataDir: string; scene: SceneSnapshot; signal?: AbortSignal; nativeExecutable?:string;
}, compile = compileNativeSceneCandidate) {
  const scene = structuredClone(options.scene), signal = options.signal;
  signal?.throwIfAborted();
  if (!scenePublicationJsonEqual(options.store.getScene(scene.projectId, scene.id), scene)) {
    throw new Error("待验证场景已变化，请重新保存");
  }
  const capture = await captureScenePublicationDependencies({ ...options, scene });
  assertCapturedSceneDependencies(scene.projectId, capture);
  const models = new Map<string, Uint8Array>();
  let totalBytes = 0;
  for (const item of scene.models) {
    if (!item.visible) continue;
    const assetId = getSceneModelAssetId(item);
    if (models.has(assetId)) continue;
    const asset = capture.inputs.project.models.find(model => model.id === assetId);
    const resource = capture.resources.find(resource => resource.sourceUrl === asset?.manifest?.geometryUrl);
    if (!resource) throw new Error(`模型 ${assetId} 缺少冻结几何资源`);
    totalBytes += resource.bytes;
    if (totalBytes > 256 * 1024 ** 2) throw new Error("候选模型总字节超过 256MiB");
    models.set(assetId, await readFrozenResource(options.objects, resource, signal));
  }
  signal?.throwIfAborted();
  const hdrResource=scene.environment?.environmentMapUrl ? capture.resources.find(resource=>resource.sourceUrl===scene.environment!.environmentMapUrl) : undefined;
  if (scene.environment?.environmentMapUrl && !hdrResource) throw new Error("HDR 环境缺少冻结来源资源");
  if (hdrResource && (hdrResource.bytes>32*1024**2 || totalBytes+hdrResource.bytes>256*1024**2)) throw new Error("HDR 或场景总字节超出预算");
  const hdrAsset=capture.inputs.project.assets?.find(asset=>asset.url===scene.environment?.environmentMapUrl);
  const hdrSource=hdrResource ? {bytes:await readFrozenResource(options.objects,hdrResource,signal),license:hdrAsset?.libraryOrigin?.license ?? "Project-provided HDR asset; redistribution rights remain with its owner"} : undefined;
  const compiled = await compile({ scene, models, ...(hdrSource ? {hdrSource} : {}), ...(options.nativeExecutable ? {nativeExecutable:options.nativeExecutable} : {}), ...(signal ? { signal } : {}) });
  signal?.throwIfAborted();
  if (!scenePublicationJsonEqual(options.store.getScene(scene.projectId, scene.id), scene)) {
    throw new Error("场景在编译期间已变化，请重新验证");
  }
  const currentProject = options.store.getProject(scene.projectId);
  if (!currentProject || !scenePublicationJsonEqual(capture.inputs,
    selectSceneClientDependencyInputs(currentProject, scene, options.store.listApplications(scene.projectId)))) {
    throw new Error("项目依赖在编译期间已变化，请重新验证");
  }
  return { scene, capture, compiled };
}

async function readFrozenResource(objects: ObjectStore,
  resource: { key: string; bytes: number; sha256: string }, signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const read = await objects.read(resource.key);
  const chunks: Buffer[] = []; let length = 0;
  const digest = createHash("sha256");
  let rejectAbort!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => {
    const error = signal?.reason instanceof Error ? signal.reason : new Error("候选资源读取已取消");
    read.stream.destroy(error); rejectAbort(error);
  };
  signal?.addEventListener("abort", abort, { once: true });
  const completed = read.completed.catch(error => { read.stream.destroy(error instanceof Error ? error : new Error(String(error))); throw error; });
  const pumping = (async () => {
    if (signal?.aborted) abort();
    for await (const part of read.stream) {
      const chunk = Buffer.from(part as Uint8Array); length += chunk.length;
      if (length > resource.bytes) throw new Error("冻结模型字节数不匹配");
      digest.update(chunk); chunks.push(chunk);
    }
  })();
  try {
    await Promise.race([Promise.all([pumping, completed]), cancelled]);
    signal?.throwIfAborted();
    if (length !== resource.bytes || digest.digest("hex") !== resource.sha256) throw new Error("冻结模型内容校验失败");
    return Buffer.concat(chunks, length);
  } finally {
    signal?.removeEventListener("abort", abort); read.stream.destroy();
    await pumping.catch(() => undefined);
  }
}
