import type { FastifyInstance, FastifyReply } from "fastify";
import { assertPathSafeResourceId, type ScriptModule } from "@bim-studio/contracts";
import type { MetadataStore } from "./store.js";
import { ScriptGitError, type ScriptGitServiceContract } from "./scriptGitTypes.js";

type ProjectParams = { projectId: string };

export async function registerScriptGitRoutes(
  app: FastifyInstance,
  dependencies: { store: MetadataStore; service: ScriptGitServiceContract },
): Promise<void> {
  app.get<{ Params: ProjectParams }>("/api/projects/:projectId/script-git/status", async (request, reply) => {
    if (!requireProject(dependencies.store, request.params.projectId, reply)) return reply;
    return run(reply, () => dependencies.service.status(request.params.projectId));
  });

  app.get<{ Params: ProjectParams; Querystring: { limit?: string } }>(
    "/api/projects/:projectId/script-git/history",
    async (request, reply) => {
      if (!requireProject(dependencies.store, request.params.projectId, reply)) return reply;
      const limit = request.query.limit === undefined ? 20 : Number(request.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) return reply.code(400).send({ message: "历史数量必须为 1-50 的整数" });
      return run(reply, () => dependencies.service.history(request.params.projectId, limit));
    },
  );

  app.post<{ Params: ProjectParams; Body: { scripts?: ScriptModule[]; message?: string } }>(
    "/api/projects/:projectId/script-git/commits",
    async (request, reply) => {
      if (!requireProject(dependencies.store, request.params.projectId, reply)) return reply;
      if (!Array.isArray(request.body?.scripts)) return reply.code(400).send({ message: "scripts 必须是数组" });
      if (typeof request.body.message !== "string") return reply.code(400).send({ message: "请填写提交说明" });
      return run(reply, () => dependencies.service.syncAndCommit(
        request.params.projectId,
        request.body.scripts!,
        request.body.message!,
      ));
    },
  );

  app.put<{ Params: ProjectParams; Body: { url?: string; branch?: string } }>(
    "/api/projects/:projectId/script-git/remote",
    async (request, reply) => {
      if (!requireProject(dependencies.store, request.params.projectId, reply)) return reply;
      if (typeof request.body?.url !== "string" || typeof request.body.branch !== "string") {
        return reply.code(400).send({ message: "请填写远端地址和分支" });
      }
      return run(reply, () => dependencies.service.configureRemote(
        request.params.projectId,
        request.body.url!,
        request.body.branch!,
      ));
    },
  );

  app.delete<{ Params: ProjectParams }>("/api/projects/:projectId/script-git/remote", async (request, reply) => {
    if (!requireProject(dependencies.store, request.params.projectId, reply)) return reply;
    return run(reply, () => dependencies.service.removeRemote(request.params.projectId));
  });

  app.post<{ Params: ProjectParams }>("/api/projects/:projectId/script-git/pull", async (request, reply) => {
    if (!requireProject(dependencies.store, request.params.projectId, reply)) return reply;
    return run(reply, () => dependencies.service.pull(request.params.projectId));
  });

  app.post<{ Params: ProjectParams }>("/api/projects/:projectId/script-git/push", async (request, reply) => {
    if (!requireProject(dependencies.store, request.params.projectId, reply)) return reply;
    return run(reply, () => dependencies.service.push(request.params.projectId));
  });
}

async function run(reply: FastifyReply, operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ScriptGitError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    return reply.code(500).send({ code: "GIT_OPERATION_FAILED", message: "脚本版本操作失败" });
  }
}

function requireProject(store: MetadataStore, projectId: string, reply: FastifyReply): boolean {
  try {
    assertPathSafeResourceId(projectId, "projectId");
  } catch (error) {
    void reply.code(400).send({ message: error instanceof Error ? error.message : "projectId 无效" });
    return false;
  }
  if (store.getProject(projectId)) return true;
  void reply.code(404).send({ message: "项目不存在" });
  return false;
}
