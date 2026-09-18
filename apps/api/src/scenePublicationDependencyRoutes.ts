import type { FastifyInstance } from "fastify";
import type { MetadataStore } from "./metadataStore.js";
import type { ObjectStore } from "./objects.js";

type Params = { projectId: string; sceneId: string; version: string; sha256: string };
/** /api/projects 复用统一登录和项目访问控制；私有资源只按版本成员读取。 */
export async function registerScenePublicationDependencyRoutes(app: FastifyInstance, deps: { store: MetadataStore; objects: ObjectStore }) {
  const base = "/api/projects/:projectId/scenes/:sceneId/publications/:version/dependencies";
  const get = (params: Params) => {
    if (!/^[1-9]\d*$/.test(params.version) || !Number.isSafeInteger(Number(params.version))) throw new Error("发布版本无效");
    return deps.store.getScenePublicationDependencies(params.projectId, params.sceneId, Number(params.version));
  };
  app.get<{ Params: Params }>(base, async (request, reply) => {
    try {
      const record = get(request.params);
      reply.header("Cache-Control", "private, no-store");
      return record ?? reply.code(409).send({ message: "该发布版本没有冻结依赖，无法重试原版本客户端包" });
    } catch (reason) { return reply.code(409).send({ message: reason instanceof Error ? reason.message : "发布依赖无效" }); }
  });
  app.get<{ Params: Params }>(`${base}/resources/:sha256`, async (request, reply) => {
    let record;
    try { record = get(request.params); }
    catch { return reply.code(409).send({ message: "发布依赖无效" }); }
    const resource = record?.resources.find(item => item.sha256 === request.params.sha256)
      ?? (record?.nativeCompiled?.runtimePackage.sha256 === request.params.sha256 ? record.nativeCompiled.runtimePackage : undefined);
    if (!resource) return reply.code(404).send({ message: "资源不属于该发布版本" });
    try {
      const result = await deps.objects.read(resource.key);
      void result.completed.catch(reason => result.stream.destroy(reason instanceof Error ? reason : new Error("资源读取失败")));
      reply.header("Cache-Control", "private, no-store");
      return reply.type("application/octet-stream").send(result.stream);
    } catch { return reply.code(404).send({ message: "冻结资源不可读取" }); }
  });
}
