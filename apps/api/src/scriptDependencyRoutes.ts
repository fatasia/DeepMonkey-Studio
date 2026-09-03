import type { FastifyInstance, FastifyReply } from "fastify";
import { assertPathSafeResourceId } from "@bim-studio/contracts";
import type { MetadataStore } from "./store.js";
import { ScriptDependencyService } from "./scriptDependencyService.js";

type ProjectParams = { projectId: string };
type DependencyParams = ProjectParams & { dependencyId: string };

export async function registerScriptDependencyRoutes(
  app: FastifyInstance,
  dependencies: { store: MetadataStore; service: ScriptDependencyService },
): Promise<void> {
  app.post<{ Params: ProjectParams; Body: { packageName?: string; version?: string; specifier?: string } }>(
    "/api/projects/:projectId/script-dependencies/npm",
    async (request, reply) => {
      if (!requireProject(dependencies.store, request.params.projectId, reply)) return reply;
      const packageName = request.body?.packageName?.trim();
      const version = request.body?.version?.trim();
      if (!packageName || !version) return reply.code(400).send({ message: "请填写 npm 包名和固定版本" });
      return runInstall(reply, () => dependencies.service.installNpm(request.params.projectId, {
        packageName,
        version,
        ...(request.body.specifier?.trim() ? { specifier: request.body.specifier.trim() } : {}),
      }));
    },
  );

  app.post<{ Params: ProjectParams; Querystring: { specifier?: string } }>(
    "/api/projects/:projectId/script-dependencies/upload",
    async (request, reply) => {
      if (!requireProject(dependencies.store, request.params.projectId, reply)) return reply;
      const specifier = request.query.specifier?.trim();
      if (!specifier) return reply.code(400).send({ message: "请填写模块名" });
      const file = await request.file({ limits: { files: 1, fileSize: 4 * 1024 * 1024 } });
      if (!file) return reply.code(400).send({ message: "请选择 JavaScript 文件" });
      const source = await file.toBuffer();
      if (file.file.truncated) return reply.code(413).send({ message: "JavaScript 文件不能超过 4 MB" });
      return runInstall(reply, () => dependencies.service.installUpload(request.params.projectId, specifier, file.filename, source));
    },
  );

  app.post<{ Params: ProjectParams; Body: { url?: string; specifier?: string } }>(
    "/api/projects/:projectId/script-dependencies/external",
    async (request, reply) => {
      if (!requireProject(dependencies.store, request.params.projectId, reply)) return reply;
      const url = request.body?.url?.trim();
      const specifier = request.body?.specifier?.trim();
      if (!url || !specifier) return reply.code(400).send({ message: "请填写外部 JS 地址和模块名" });
      return runInstall(reply, () => dependencies.service.installExternal(request.params.projectId, { url, specifier }));
    },
  );

  app.get<{ Params: DependencyParams; Querystring: { download?: string } }>(
    "/api/projects/:projectId/script-dependencies/:dependencyId/content",
    async (request, reply) => {
      if (!requireProject(dependencies.store, request.params.projectId, reply)) return reply;
      if (!validId(request.params.dependencyId, "dependencyId", reply)) return reply;
      try {
        const result = await dependencies.service.content(request.params.projectId, request.params.dependencyId);
        void result.completed.catch((error) => request.log.error(error));
        reply.header("Cache-Control", "private, max-age=31536000, immutable");
        if (request.query.download === "1") reply.header("Content-Disposition", `attachment; filename="${request.params.dependencyId}.mjs"`);
        return reply.type("text/javascript; charset=utf-8").send(result.stream);
      } catch {
        return reply.code(404).send({ message: "脚本依赖不存在" });
      }
    },
  );

  app.delete<{ Params: DependencyParams }>(
    "/api/projects/:projectId/script-dependencies/:dependencyId",
    async (request, reply) => {
      if (!requireProject(dependencies.store, request.params.projectId, reply)) return reply;
      if (!validId(request.params.dependencyId, "dependencyId", reply)) return reply;
      await dependencies.service.remove(request.params.projectId, request.params.dependencyId);
      return reply.code(204).send();
    },
  );
}

async function runInstall(reply: FastifyReply, install: () => Promise<unknown>): Promise<unknown> {
  try {
    return reply.code(201).send(await install());
  } catch (error) {
    return reply.code(400).send({ message: error instanceof Error ? error.message : "脚本依赖安装失败" });
  }
}

function requireProject(store: MetadataStore, projectId: string, reply: FastifyReply): boolean {
  if (!validId(projectId, "projectId", reply)) return false;
  if (store.getProject(projectId)) return true;
  void reply.code(404).send({ message: "项目不存在" });
  return false;
}

function validId(value: string, label: string, reply: FastifyReply): boolean {
  try {
    assertPathSafeResourceId(value, label);
    return true;
  } catch (error) {
    void reply.code(400).send({ message: error instanceof Error ? error.message : `${label} 无效` });
    return false;
  }
}
