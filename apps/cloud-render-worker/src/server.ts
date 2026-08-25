import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { CloudRenderWorkerSessionRequest } from "@bim-studio/server-sdk";
import type { CloudRenderWorkerConfig } from "./config.js";
import type { RenderRuntime } from "./chromiumRuntime.js";
import { CloudRenderSessionManager, WorkerRequestError } from "./sessionManager.js";
import { viewerHtml } from "./viewer.js";

type SessionParams = { id: string };

export function buildWorkerApp(config: CloudRenderWorkerConfig, runtime: RenderRuntime) {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  const manager = new CloudRenderSessionManager(config, runtime);

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/v1/") || request.url.startsWith("/v1/viewer/")) return;
    if (request.headers.authorization !== `Bearer ${config.token}`) return reply.code(401).send({ message: "Worker token 无效", code: "unauthorized" });
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    return payload;
  });

  app.get("/v1/health", async () => manager.health());
  app.post<{ Body: CloudRenderWorkerSessionRequest }>("/v1/sessions", async (request, reply) => {
    try { return reply.code(201).send(await manager.create(request.body)); }
    catch (reason) { return sendError(reply, reason); }
  });
  app.get<{ Params: SessionParams }>("/v1/sessions/:id", async (request, reply) => {
    try { return await manager.get(request.params.id); }
    catch (reason) { return sendError(reply, reason); }
  });
  app.delete<{ Params: SessionParams }>("/v1/sessions/:id", async (request, reply) => {
    try { return (await manager.stop(request.params.id)) ? reply.code(204).send() : reply.code(404).send({ message: "会话不存在", code: "session_not_found" }); }
    catch (reason) { return sendError(reply, reason); }
  });

  app.get<{ Params: SessionParams }>("/viewer/:id", async (request, reply) => {
    reply.header("content-security-policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; media-src blob:");
    return reply.type("text/html; charset=utf-8").send(viewerHtml(request.params.id, config.iceServers));
  });
  app.get<{ Params: SessionParams }>("/v1/viewer/:id/offer", async (request, reply) => {
    try { return await manager.offer(request.params.id, viewerToken(request)); }
    catch (reason) { return sendError(reply, reason); }
  });
  app.post<{ Params: SessionParams; Body: RTCSessionDescriptionInit }>("/v1/viewer/:id/answer", async (request, reply) => {
    try { await manager.answer(request.params.id, viewerToken(request), request.body); return reply.code(204).send(); }
    catch (reason) { return sendError(reply, reason); }
  });

  app.addHook("onClose", async () => manager.close());
  return app;
}

function sendError(reply: FastifyReply, reason: unknown) {
  if (reason instanceof WorkerRequestError) return reply.code(reason.statusCode).send({ message: reason.message, code: reason.code });
  return reply.code(500).send({ message: reason instanceof Error ? reason.message : String(reason), code: "worker_internal_error" });
}

export function bearer(request: FastifyRequest): string | undefined {
  return request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : undefined;
}

function viewerToken(request: FastifyRequest): string {
  const value = request.headers["x-cloud-render-viewer-token"];
  return typeof value === "string" ? value : "";
}
