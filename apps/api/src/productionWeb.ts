import staticFiles from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

export interface ProductionWebOptions {
  enabled?: boolean;
  root?: string;
}

/**
 * 生产环境由 API 进程直接托管已构建 Web 资源，原生部署只需守护一个进程。
 * API、模型与 Web 同源也能减少代理配置错误；未知 API 仍返回 JSON 404。
 */
export async function registerProductionWeb(app: FastifyInstance, options: ProductionWebOptions = {}): Promise<void> {
  const enabled = options.enabled ?? process.env.NODE_ENV === "production";
  if (!enabled) return;
  const root = path.resolve(options.root ?? process.env.WEB_DIST_DIR ?? path.join(projectRoot, "apps", "web", "dist"));
  const entry = path.join(root, "index.html");
  if (!existsSync(entry)) throw new Error(`生产 Web 资源不存在：${entry}`);

  await app.register(staticFiles, {
    root,
    prefix: "/",
    wildcard: true,
    cacheControl: true,
    immutable: false,
    maxAge: "1h",
  });

  app.setNotFoundHandler((request, reply) => {
    const acceptsHtml = request.headers.accept?.includes("text/html") ?? false;
    if (request.method === "GET" && acceptsHtml && !request.url.startsWith("/api/")) {
      return reply.header("cache-control", "no-cache").sendFile("index.html");
    }
    return reply.code(404).send({ message: "请求的资源不存在" });
  });
}
