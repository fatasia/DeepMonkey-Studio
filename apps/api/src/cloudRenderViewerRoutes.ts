import type { FastifyInstance } from "fastify";
import { assertPathSafeResourceId } from "@bim-studio/contracts";

interface Options {
  workerUrl?: string | undefined;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** 只代理 viewer 的三个固定路由；媒体授权仍由 Worker 的会话令牌负责。 */
export function registerCloudRenderViewerRoutes(app: FastifyInstance, options: Options): void {
  const fetchWorker = options.fetch ?? globalThis.fetch;
  for (const [method, route] of [
    ["GET", "/viewer/:id"],
    ["GET", "/v1/viewer/:id/offer"],
    ["POST", "/v1/viewer/:id/answer"],
  ] as const) {
    app.route<{ Params: { id: string } }>({
      method, url: route, bodyLimit: 256 * 1024,
      handler: async (request, reply) => {
        reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
        try { assertPathSafeResourceId(request.params.id, "sessionId"); }
        catch { return reply.code(400).send({ code: "invalid_session_id", message: "云渲染会话 ID 无效" }); }
        if (!options.workerUrl) return reply.code(503).send({ code: "worker_not_configured", message: "云渲染 Worker 尚未配置" });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
        const disconnect = () => { if (!reply.raw.writableFinished) controller.abort(); };
        reply.raw.once("close", disconnect);
        try {
          const url = `${options.workerUrl.replace(/\/$/, "")}${route.replace(":id", encodeURIComponent(request.params.id))}`;
          const headers: Record<string, string> = {};
          const token = request.headers["x-cloud-render-viewer-token"];
          if (typeof token === "string") headers["x-cloud-render-viewer-token"] = token;
          if (method === "POST") headers["content-type"] = "application/json";
          // 不转发浏览器 Cookie、Authorization 或内部 Worker 管理令牌，也不跟随上游重定向。
          const response = await fetchWorker(url, {
            method, headers, redirect: "error", signal: controller.signal,
            ...(method === "POST" ? { body: JSON.stringify(request.body) } : {}),
          });
          const chunks: Uint8Array[] = [];
          let size = 0;
          if (response.body) {
            for await (const chunk of response.body) {
              size += chunk.byteLength;
              if (size > 1024 * 1024) { controller.abort(); throw new Error("response-too-large"); }
              chunks.push(chunk);
            }
          }
          for (const name of ["content-type", "content-security-policy", "retry-after"]) {
            const value = response.headers.get(name);
            if (value) reply.header(name, value);
          }
          return reply.code(response.status).send(response.status === 204 ? undefined : Buffer.concat(chunks));
        } catch {
          return reply.code(502).send({ code: "worker_unavailable", message: "云渲染服务暂不可达，请检查 Worker 状态后重试" });
        } finally {
          clearTimeout(timeout);
          reply.raw.removeListener("close", disconnect);
        }
      },
    });
  }
}
