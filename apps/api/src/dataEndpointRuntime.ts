import { randomUUID } from "node:crypto";
import type { DataEndpointDefinition, DataStreamEnvelope } from "@bim-studio/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import { authenticateDataEndpoint } from "./dataEndpointAuth.js";
import { previewPipeline } from "./dataPipelineService.js";
import type { MetadataStore } from "./store.js";

const rateWindows = new Map<string, { startedAt: number; count: number }>();

export async function registerDataEndpointRuntime(app: FastifyInstance, store: MetadataStore, config: AppConfig): Promise<void> {
  app.route<{ Params: { projectId: string; slug: string } }>({
    method: ["GET", "POST"],
    url: "/runtime/data/:projectId/rest/:slug",
    handler: async (request, reply) => {
      const endpoint = findEndpoint(store, request.params.projectId, request.params.slug, "rest");
      if (!endpoint?.enabled) return reply.code(404).send({ message: "接口不存在或未启用" });
      if (request.method !== (endpoint.method ?? "GET")) return reply.code(405).header("allow", endpoint.method ?? "GET").send({ message: `接口仅允许 ${endpoint.method ?? "GET"}` });
      if (!authenticateDataEndpoint(request, store, endpoint.id)) return reply.code(401).send({ message: "API Key 无效" });
      if (!consumeRateLimit(endpoint, request)) return reply.code(429).header("retry-after", "60").send({ message: "请求频率超过接口限制" });
      const definition = store.listDataPipelines(request.params.projectId).find((pipeline) => pipeline.id === endpoint.pipelineId);
      if (!definition) return reply.code(503).send({ message: "接口引用的流水线不存在" });
      const result = await previewPipeline(config, store, definition);
      reply.header("cache-control", "no-store");
      if (result.status === "error") return reply.code(502).send({ endpointId: endpoint.id, generatedAt: new Date().toISOString(), status: "error", message: "数据处理失败，请联系接口管理员" });
      return { endpointId: endpoint.id, generatedAt: new Date().toISOString(), schemaVersion: "1", status: "success", fields: result.fields, rows: result.rows, durationMs: result.durationMs };
    }
  });

  app.get<{ Params: { projectId: string; slug: string } }>("/runtime/data/:projectId/ws/:slug", { websocket: true }, (socket, request) => {
    const endpoint = findEndpoint(store, request.params.projectId, request.params.slug, "websocket");
    if (!endpoint?.enabled || !authenticateDataEndpoint(request, store, endpoint.id)) {
      socket.close(4401, "API Key invalid");
      return;
    }
    if (!consumeRateLimit(endpoint, request)) {
      socket.close(4429, "Rate limit exceeded");
      return;
    }
    const definition = store.listDataPipelines(request.params.projectId).find((pipeline) => pipeline.id === endpoint.pipelineId);
    if (!definition) {
      socket.close(4503, "Pipeline unavailable");
      return;
    }
    let running = false;
    const intervalMs = Math.max(endpoint.intervalMs ?? 5_000, Math.ceil(60_000 / endpoint.requestsPerMinute));
    const channel = endpoint.channel || endpoint.slug;
    const send = (envelope: DataStreamEnvelope) => {
      if (socket.readyState !== 1) return;
      if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013, "Slow consumer"); return; }
      if (socket.bufferedAmount > 512 * 1024) return;
      const serialized = JSON.stringify(envelope);
      if (Buffer.byteLength(serialized) > 240 * 1024) {
        socket.send(JSON.stringify(createEnvelope("error", channel, { message: "消息超过 240KB 限制" })));
        return;
      }
      socket.send(serialized);
    };
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const result = await previewPipeline(config, store, definition);
        send(createEnvelope(result.status === "success" ? "data" : "error", channel, result.status === "success" ? { status: "success", fields: result.fields, rows: result.rows, durationMs: result.durationMs } : { status: "error", message: "数据处理失败，请联系接口管理员" }));
      } catch (reason) {
        send(createEnvelope("error", channel, { message: reason instanceof Error ? reason.message : String(reason) }));
      } finally {
        running = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    const cleanup = () => clearInterval(timer);
    socket.once("close", cleanup);
    socket.once("error", cleanup);
  });
}

function findEndpoint(store: MetadataStore, projectId: string, slug: string, kind: DataEndpointDefinition["kind"]): DataEndpointDefinition | undefined {
  if (!store.getProject(projectId)) return undefined;
  return store.listDataEndpoints(projectId).find((endpoint) => endpoint.kind === kind && endpoint.slug === slug);
}

function consumeRateLimit(endpoint: DataEndpointDefinition, request: FastifyRequest): boolean {
  const key = `${endpoint.id}:${request.ip}`;
  const now = Date.now();
  if (rateWindows.size > 10_000) for (const [entryKey, value] of rateWindows) if (now - value.startedAt > 120_000) rateWindows.delete(entryKey);
  const current = rateWindows.get(key);
  if (!current || now - current.startedAt >= 60_000) {
    rateWindows.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= endpoint.requestsPerMinute) return false;
  current.count += 1;
  return true;
}

function createEnvelope(type: DataStreamEnvelope["type"], channel: string, payload: unknown): DataStreamEnvelope {
  return { type, channel, messageId: randomUUID(), timestamp: new Date().toISOString(), schemaVersion: "1", payload };
}
