import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { DataEvent, DataEventAction, DataEventTarget } from "@bim-studio/contracts";
import type { MetadataStore } from "./store.js";

type DataEventListener = (event: DataEvent) => void;
const ACTIONS = new Set<DataEventAction>(["color", "visibility", "position", "label", "opacity", "focus", "animation", "effects", "material", "alarm"]);

export class DataEventBus {
  private readonly listeners = new Map<string, Set<{ sceneId?: string; listener: DataEventListener }>>();
  private readonly retained = new Map<string, DataEvent[]>();

  publish(event: DataEvent): void {
    const recent = [...(this.retained.get(event.projectId) ?? []), event].slice(-200);
    this.retained.set(event.projectId, recent);
    for (const subscription of this.listeners.get(event.projectId) ?? []) {
      if (!subscription.sceneId || !event.sceneId || event.sceneId === subscription.sceneId) subscription.listener(event);
    }
  }

  subscribe(projectId: string, sceneId: string | undefined, listener: DataEventListener): () => void {
    const subscriptions = this.listeners.get(projectId) ?? new Set();
    const subscription = { ...(sceneId ? { sceneId } : {}), listener };
    subscriptions.add(subscription);
    this.listeners.set(projectId, subscriptions);
    return () => {
      subscriptions.delete(subscription);
      if (subscriptions.size === 0) this.listeners.delete(projectId);
    };
  }

  latest(projectId: string, sceneId?: string): DataEvent[] {
    return (this.retained.get(projectId) ?? []).filter((event) => !sceneId || !event.sceneId || event.sceneId === sceneId);
  }
}

export async function registerDataEventRoutes(app: FastifyInstance, store: MetadataStore, bus = new DataEventBus()): Promise<DataEventBus> {
  app.post<{ Params: { projectId: string }; Body: Partial<DataEvent> }>("/api/projects/:projectId/data/events", async (request, reply) => {
    if (!store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    const normalized = normalizeEvent(request.params.projectId, request.body);
    if ("message" in normalized) return reply.code(400).send(normalized);
    bus.publish(normalized);
    return reply.code(202).send(normalized);
  });

  app.get<{ Params: { projectId: string }; Querystring: { sceneId?: string } }>("/api/projects/:projectId/data/events/latest", async (request, reply) => {
    if (!store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    return bus.latest(request.params.projectId, request.query.sceneId);
  });

  app.get<{ Params: { projectId: string }; Querystring: { sceneId?: string } }>("/api/projects/:projectId/data/ws", { websocket: true }, (socket, request) => {
    const send = (event: DataEvent) => sendJson(socket, event);
    const unsubscribe = bus.subscribe(request.params.projectId, request.query.sceneId, send);
    socket.on("message", (message) => {
      if (message.toString() === "ping") socket.send("pong");
    });
    socket.once("close", unsubscribe);
    socket.once("error", unsubscribe);
    for (const event of bus.latest(request.params.projectId, request.query.sceneId)) send(event);
  });

  return bus;
}

function normalizeEvent(projectId: string, input: Partial<DataEvent>): DataEvent | { message: string } {
  const source = input.source?.trim();
  const key = input.key?.trim();
  if (!source || !key || !("value" in input)) return { message: "数据事件必须包含 source、key 和 value" };
  if (source.length > 128 || key.length > 128) return { message: "source 和 key 最长 128 个字符" };
  if (input.action && !ACTIONS.has(input.action)) return { message: `不支持的数据动作：${input.action}` };
  return {
    id: input.id || randomUUID(),
    projectId,
    source,
    key,
    value: input.value,
    timestamp: validTimestamp(input.timestamp),
    ...(input.sceneId?.trim() ? { sceneId: input.sceneId.trim() } : {}),
    ...(validTarget(input.target) ? { target: input.target } : {}),
    ...(input.action ? { action: input.action } : {})
  };
}

function validTimestamp(timestamp?: string): string {
  return timestamp && Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : new Date().toISOString();
}

function validTarget(target?: DataEventTarget): target is DataEventTarget {
  return Boolean(target && (target.modelId || target.layerId || target.annotationId));
}

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(value));
}
