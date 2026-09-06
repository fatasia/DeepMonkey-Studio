import type { FastifyInstance, FastifyReply } from "fastify";
import { assertPathSafeResourceId, getSceneModelAssetId, type ProjectRecord, type PublishedApplicationRecord } from "@bim-studio/contracts";
import type { MetadataStore } from "./store.js";
import type { ScriptDependencyService } from "./scriptDependencyService.js";

/** 与公开场景相同：只给渲染所需资源，不把项目管理/数据源配置带入匿名边界。 */
export function publishedApplicationBundle(publication: PublishedApplicationRecord, project: ProjectRecord) {
  if (publication.projectId !== project.id) throw new Error("发布快照与项目不匹配");
  const modelIds = new Set(publication.document.scenes.flatMap(scene => scene.models.map(getSceneModelAssetId)));
  const content = JSON.stringify(publication.document);
  const assets = project.assets?.filter(asset => content.includes(asset.url));
  return {
    publication: structuredClone(publication),
    project: {
      id: project.id, name: project.name, description: project.description,
      createdAt: project.createdAt, updatedAt: project.updatedAt,
      models: project.models.filter(model => modelIds.has(model.id)).map(model => structuredClone(model)),
      ...(assets?.length ? { assets: structuredClone(assets) } : {}),
    } satisfies ProjectRecord,
  };
}

export function activeApplicationPublication(store: MetadataStore, applicationId: string) {
  const pointer = store.getApplicationPublicationPointer(applicationId);
  if (!pointer || !store.getApplication(pointer.projectId, applicationId) || !store.getProject(pointer.projectId)) return;
  const publication = store.getPublishedApplication(pointer.activePublicationId);
  return publication?.applicationId === applicationId && publication.projectId === pointer.projectId ? publication : undefined;
}

export async function registerPublishedApplicationRoutes(app: FastifyInstance, options: { store: MetadataStore; dependencies: Pick<ScriptDependencyService, "content"> }) {
  app.get<{ Params: { applicationId: string } }>("/api/public/applications/:applicationId/browse", async (request, reply) => {
    if (!validIds(reply, request.params.applicationId)) return reply;
    const publication = activeApplicationPublication(options.store, request.params.applicationId);
    const project = publication && options.store.getProject(publication.projectId);
    if (!publication || !project) return reply.code(404).send({ message: "应用尚未发布或已撤回" });
    reply.header("Cache-Control", "no-store");
    return publishedApplicationBundle(publication, project);
  });

  app.get<{ Params: { applicationId: string; publicationId: string; dependencyId: string } }>(
    "/api/public/applications/:applicationId/revisions/:publicationId/dependencies/:dependencyId",
    async (request, reply) => {
      const { applicationId, publicationId, dependencyId } = request.params;
      if (!validIds(reply, applicationId, publicationId, dependencyId)) return reply;
      const publication = options.store.getPublishedApplication(publicationId);
      if (!publication || publication.applicationId !== applicationId || !options.store.getProject(publication.projectId)
        || !publication.document.scriptDependencies?.some(dependency => dependency.id === dependencyId)) {
        return reply.code(404).send({ message: "发布版本未引用此脚本依赖" });
      }
      try {
        const result = await options.dependencies.content(publication.projectId, dependencyId);
        void result.completed.catch(error => request.log.error(error));
        // 源文件由不可变依赖ID锁定，内容完整性仍由Worker校验。
        reply.header("Cache-Control", "public, max-age=31536000, immutable");
        return reply.type("text/javascript; charset=utf-8").send(result.stream);
      } catch { return reply.code(404).send({ message: "发布脚本依赖文件缺失，请联系发布者" }); }
    },
  );
}

function validIds(reply: FastifyReply, ...ids: string[]) {
  try { ids.forEach(id => assertPathSafeResourceId(id, "id")); return true; }
  catch { void reply.code(400).send({ message: "资源标识无效" }); return false; }
}

export function isScriptDependencyReferenced(store: MetadataStore, projectId: string, dependencyId: string) {
  return store.listApplications(projectId).some(application => application.scriptDependencies?.some(dependency => dependency.id === dependencyId))
    || store.listApplicationPublications().some(publication => publication.projectId === projectId
      && publication.document.scriptDependencies?.some(dependency => dependency.id === dependencyId));
}
