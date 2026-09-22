import type { FastifyInstance } from "fastify";
import { parseClientPackageBranding } from "./clientPackageBranding.js";
import { createSceneStandaloneExecutable, type SceneExecutableDependencies } from "./sceneStandaloneExecutable.js";
import { httpDisconnectScope } from "./httpDisconnectScope.js";

export async function registerSceneStandaloneExecutableRoutes(app: FastifyInstance, deps: SceneExecutableDependencies) {
  app.post<{ Params: { projectId: string; sceneId: string; version: string }; Body: { branding?: unknown } }>(
    "/api/projects/:projectId/scenes/:sceneId/publications/:version/native-executable", { bodyLimit: 3 * 1024 ** 2 }, async (request, reply) => {
      const user = request.systemUser;
      if (!user || !user.enabled) return reply.code(401).send({ message: "客户端下载需要登录用户" });
      if (user.role === "viewer") return reply.code(403).send({ message: "当前角色没有客户端下载权限" });
      if (user.role !== "admin" && !user.projectIds.includes(request.params.projectId)) return reply.code(403).send({ message: "无项目访问权限" });
      const { projectId, sceneId, version } = request.params;
      if (!/^[1-9]\d*$/.test(version) || !Number.isSafeInteger(Number(version)) || !request.body
        || typeof request.body !== "object" || Array.isArray(request.body) || Object.keys(request.body).some(key => key !== "branding")) {
        return reply.code(400).send({ message: "下载版本或客户端品牌参数无效" });
      }
      const disconnect = httpDisconnectScope(request.raw, reply.raw);
      const signal = AbortSignal.any([disconnect.signal, AbortSignal.timeout(180_000)]);
      try {
        let branding;
        try { branding = request.body.branding === undefined ? undefined : await parseClientPackageBranding(request.body.branding, signal); }
        catch (reason) { return reply.code(400).send({ code: "invalid_client_branding", message: reason instanceof Error ? reason.message : "客户端品牌无效" }); }
        const result = await createSceneStandaloneExecutable(deps, { projectId, sceneId, version: Number(version), signal,
          ...(branding ? { branding } : {}) });
        const name = (branding?.applicationName ?? "DeepMonkey Studio").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "") || "DeepMonkey Studio";
        signal.throwIfAborted();
        return reply.header("Cache-Control", "private, no-store").header("X-Native-Artifact-Sha256", result.artifactSha256)
          .header("Content-Disposition", `attachment; filename="scene-client.exe"; filename*=UTF-8''${encodeURIComponent(`${name}.exe`).replace(/'/g, "%27")}`)
          .type("application/vnd.microsoft.portable-executable").send(Buffer.from(result.bytes));
      } catch (reason) { return reply.code(409).send({ message: reason instanceof Error ? reason.message : "Scene EXE 打包失败" }); }
      finally { disconnect.dispose(); }
    });
}
