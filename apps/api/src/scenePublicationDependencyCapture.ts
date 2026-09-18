import type { SceneSnapshot, SceneClientDependencyExpectation } from "@bim-studio/contracts";
import { selectSceneClientDependencyInputs } from "@bim-studio/studio-core";
import type { MetadataStore } from "./metadataStore.js";
import type { ObjectStore } from "./objects.js";
import { capturePublicationResource } from "./publicationResourceSnapshot.js";
import { scenePublicationJsonEqual } from "./scenePublicationStore.js";

/** 发布提交前捕获私有字节；失败留下的共享 blob 由引用回收处理，不在请求中删除。 */
export async function captureScenePublicationDependencies(options: {
  store: MetadataStore; objects: ObjectStore; dataDir: string; scene: SceneSnapshot;
  expected?: SceneClientDependencyExpectation; signal?: AbortSignal;
}) {
  options.signal?.throwIfAborted();
  const scene = structuredClone(options.scene), expected = options.expected ? structuredClone(options.expected) : undefined;
  const project = options.store.getProject(scene.projectId);
  if (!project) throw new Error("发布项目不存在");
  const inputs = selectSceneClientDependencyInputs(project, scene, options.store.listApplications(scene.projectId));
  if (expected && !scenePublicationJsonEqual(expected.inputs, inputs)) throw new Error("预检后的应用或项目依赖已变化，请重新检查");
  if (inputs.resources.length > 10_000) throw new Error("发布资源数量超过限制");
  if (expected && (expected.resources.length !== inputs.resources.length
    || new Set(expected.resources.map(item => item.sourceUrl)).size !== inputs.resources.length)) throw new Error("预检资源清单不完整或重复");
  const resources = [];
  let totalBytes = 0;
  for (const resource of inputs.resources) {
    options.signal?.throwIfAborted();
    if (!resource.url.startsWith("/assets/") || /[?#]/.test(resource.url)) throw new Error(`资源 ${resource.name} 需要先保存为项目内静态文件`);
    const sourceKey = decodeURIComponent(resource.url.slice("/assets/".length));
    const claim = expected?.resources.find(item => item.sourceUrl === resource.url);
    if (expected && !claim) throw new Error("预检资源清单与当前引用不符");
    const captured = await capturePublicationResource({ objects: options.objects, dataDir: options.dataDir,
      projectId: scene.projectId, sourceKey, ...(options.signal ? { signal: options.signal } : {}), ...(claim ? { expected: claim } : {}),
      maxBytes: Math.min(256 * 1024 ** 2, 1024 ** 3 - totalBytes) });
    totalBytes += captured.bytes;
    for (const declared of resource.claims) {
      if ((declared.bytes !== undefined && declared.bytes !== captured.bytes)
        || (declared.sha256 && declared.sha256 !== captured.sha256)
        || (declared.integrity && declared.integrity !== `sha256-${Buffer.from(captured.sha256, "hex").toString("base64")}`)) {
        throw new Error(`资源 ${resource.name} 的内容与记录不符`);
      }
    }
    resources.push({ sourceUrl: resource.url, ...captured });
  }
  options.signal?.throwIfAborted();
  return { inputs, resources };
}
