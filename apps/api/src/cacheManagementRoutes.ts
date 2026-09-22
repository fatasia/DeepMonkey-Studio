import type { FastifyInstance } from "fastify";
import { threeSceneViewerCache, type ThreeSceneViewerCache } from "./threeSceneViewerCache.js";

export function registerCacheManagementRoutes(app: FastifyInstance, cache: ThreeSceneViewerCache = threeSceneViewerCache): void {
  for (const method of ["GET", "DELETE"] as const) {
    app.route({ method, url: "/api/admin/cache/three-scene-viewer", handler: async (request, reply) => {
      if (!request.systemUser) return reply.code(401).send({ message: "请先登录" });
      if (request.systemUser.role !== "admin") return reply.code(403).send({ message: "需要管理员权限" });
      reply.header("cache-control", "no-store");
      try { return method === "GET" ? await cache.inspect() : await cache.clear(); }
      catch { return reply.code(500).send({ message: "无法访问打包缓存，请检查目录权限或稍后重试" }); }
    } });
  }
}
