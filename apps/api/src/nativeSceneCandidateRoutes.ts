import type { FastifyInstance } from "fastify";
import type { SceneSnapshot } from "@bim-studio/contracts";
import type { createNativeSceneCandidateService } from "./nativeSceneCandidateService.js";
import { httpDisconnectScope } from "./httpDisconnectScope.js";

export type NativeSceneCandidateService = ReturnType<typeof createNativeSceneCandidateService>;

export async function registerNativeSceneCandidateRoutes(app: FastifyInstance, service?: NativeSceneCandidateService) {
  app.post<{ Params: { projectId: string; sceneId: string }; Body: { expectedSnapshot?: SceneSnapshot } }>(
    "/api/projects/:projectId/scenes/:sceneId/native-candidates", async (request, reply) => {
      if (!request.systemUser) return reply.code(401).send({ message: "Native 验证需要登录用户" });
      const scene = request.body?.expectedSnapshot;
      if (!scene || scene.schemaVersion !== 1 || scene.id !== request.params.sceneId || scene.projectId !== request.params.projectId
        || Object.keys(request.body).some(key => key !== "expectedSnapshot")) {
        return reply.code(400).send({ message: "Native 验证需要当前保存快照，不能指定程序或证据" });
      }
      if (!service) return reply.code(503).send({ message: "本机 Native 窗口验证未配置，请由管理员配置验证程序" });
      const disconnect = httpDisconnectScope(request.raw, reply.raw);
      try {
        const result = await service.prepare(request.systemUser.id, scene,
          AbortSignal.any([disconnect.signal, AbortSignal.timeout(180_000)]));
        return reply.header("cache-control", "private, no-store").send(result);
      } catch (reason) {
        return reply.code(409).send({ message: reason instanceof Error ? reason.message : "Native 候选验证失败" });
      } finally { disconnect.dispose(); }
    });
}
