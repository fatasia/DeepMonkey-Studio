import type { FastifyInstance } from "fastify";
import type { MetadataStore } from "./metadataStore.js";
import { httpDisconnectScope } from "./httpDisconnectScope.js";
import { buildThreeSceneViewerExecutable, inspectThreeSceneArchive } from "./threeSceneViewerExecutable.js";

export async function registerThreeSceneViewerExecutableRoutes(app: FastifyInstance, dependencies: {
  store: MetadataStore;
  launcherExecutable?: string;
  builderScript?: string;
}) {
  app.post<{ Params: { projectId: string; sceneId: string; version: string } }>(
    "/api/projects/:projectId/scenes/:sceneId/publications/:version/three-webview-executable",
    async (request, reply) => {
      const user = request.systemUser;
      if (!user?.enabled) return reply.code(401).send({ message: "客户端下载需要登录用户" });
      if (user.role === "viewer") return reply.code(403).send({ message: "当前角色没有客户端下载权限" });
      if (user.role !== "admin" && !user.projectIds.includes(request.params.projectId)) return reply.code(403).send({ message: "无项目访问权限" });
      if (!dependencies.launcherExecutable && !dependencies.builderScript) return reply.code(503).send({
        message: "Three WebView 通用启动器未配置",
        code: "THREE_WEBVIEW_LAUNCHER_UNAVAILABLE",
      });
      const version = Number(request.params.version);
      if (!Number.isSafeInteger(version) || version < 1) return reply.code(400).send({ message: "发布版本无效" });
      const publication = dependencies.store.listScenePublications(request.params.sceneId).find(item => item.version === version
        && item.projectId === request.params.projectId && item.sceneId === request.params.sceneId);
      if (!publication) return reply.code(404).send({ message: "发布版本不存在" });
      const disconnect = httpDisconnectScope(request.raw, reply.raw);
      const signal = AbortSignal.any([disconnect.signal, AbortSignal.timeout(10 * 60_000)]);
      try {
        const upload = await request.file({ limits: { files: 1, fields: 0, fileSize: 256 * 1024 ** 2 } });
        if (!upload || upload.fieldname !== "archive") return reply.code(400).send({ message: "缺少 Three WebView 客户端包" });
        const bytes = Buffer.from(await upload.toBuffer());
        const identity = await inspectThreeSceneArchive(bytes);
        if (identity.projectId !== publication.projectId || identity.sceneId !== publication.sceneId
          || identity.publishedAt !== publication.publishedAt) return reply.code(409).send({ message: "客户端包与发布版本不一致" });
        const executable = await buildThreeSceneViewerExecutable(dependencies, bytes, signal);
        signal.throwIfAborted();
        return reply.header("Cache-Control", "private, no-store")
          .header("Content-Disposition", "attachment; filename=three-webview.exe")
          .type("application/vnd.microsoft.portable-executable").send(executable);
      } catch (reason) {
        return reply.code(409).send({ message: reason instanceof Error ? reason.message : "Three WebView 客户端构建失败" });
      } finally { disconnect.dispose(); }
    });
}
