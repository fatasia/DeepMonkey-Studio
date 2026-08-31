import type { FastifyInstance } from "fastify";
import type {
  NotificationEvent,
  NotificationRecipient,
  NotificationRule,
  NotificationTemplate,
} from "@bim-studio/contracts";
import type { NotificationChannelInput } from "./notificationConfigurationStore.js";
import type { NotificationRuntime } from "./notificationRuntime.js";

/** 管理端只获得脱敏快照；渠道端点和密钥仅可写入，不能回读。 */
export async function registerNotificationRoutes(app: FastifyInstance, runtime: NotificationRuntime): Promise<void> {
  app.get("/api/admin/notifications/snapshot", async () => runtime.configuration.snapshot());
  app.get("/api/admin/notifications/audit", async (request) => {
    const { limit } = request.query as { limit?: string };
    return runtime.service.listAudit(Number(limit ?? 200));
  });
  app.post<{ Body: NotificationEvent }>("/api/admin/notifications/test", async (request, reply) => {
    if (!isCompleteEvent(request.body)) return reply.code(400).send({ message: "通知测试事件不完整" });
    return { audit: await runtime.service.dispatch(request.body) };
  });

  registerChannelRoutes(app, runtime);
  registerRecipientRoutes(app, runtime);
  registerRuleRoutes(app, runtime);
  registerTemplateRoutes(app, runtime);
}

function registerChannelRoutes(app: FastifyInstance, runtime: NotificationRuntime): void {
  app.post<{ Body: NotificationChannelInput }>("/api/admin/notifications/channels", async (request, reply) => {
    return mutationReply(reply, runtime, () => runtime.configuration.putChannel(request.body, true), 201);
  });
  app.put<{ Params: { id: string }; Body: NotificationChannelInput }>("/api/admin/notifications/channels/:id", async (request, reply) => {
    return mutationReply(reply, runtime, () => runtime.configuration.putChannel({ ...request.body, id: request.params.id }, false));
  });
  app.delete<{ Params: { id: string } }>("/api/admin/notifications/channels/:id", async (request, reply) => {
    return mutationReply(reply, runtime, () => runtime.configuration.remove("channels", request.params.id));
  });
}

function registerRecipientRoutes(app: FastifyInstance, runtime: NotificationRuntime): void {
  app.post<{ Body: NotificationRecipient }>("/api/admin/notifications/recipients", async (request, reply) => {
    return mutationReply(reply, runtime, () => runtime.configuration.put("recipients", request.body, true), 201);
  });
  app.put<{ Params: { id: string }; Body: NotificationRecipient }>("/api/admin/notifications/recipients/:id", async (request, reply) => {
    return mutationReply(reply, runtime, () => runtime.configuration.put("recipients", { ...request.body, id: request.params.id }, false));
  });
  app.delete<{ Params: { id: string } }>("/api/admin/notifications/recipients/:id", async (request, reply) => {
    return mutationReply(reply, runtime, () => runtime.configuration.remove("recipients", request.params.id));
  });
}

function registerRuleRoutes(app: FastifyInstance, runtime: NotificationRuntime): void {
  app.post<{ Body: NotificationRule }>("/api/admin/notifications/rules", async (request, reply) => {
    return mutationReply(reply, runtime, () => runtime.configuration.put("rules", request.body, true), 201);
  });
  app.put<{ Params: { id: string }; Body: NotificationRule }>("/api/admin/notifications/rules/:id", async (request, reply) => {
    return mutationReply(reply, runtime, () => runtime.configuration.put("rules", { ...request.body, id: request.params.id }, false));
  });
  app.delete<{ Params: { id: string } }>("/api/admin/notifications/rules/:id", async (request, reply) => {
    return mutationReply(reply, runtime, () => runtime.configuration.remove("rules", request.params.id));
  });
}

function registerTemplateRoutes(app: FastifyInstance, runtime: NotificationRuntime): void {
  app.post<{ Body: NotificationTemplate }>("/api/admin/notifications/templates", async (request, reply) => {
    return mutationReply(reply, runtime, () => runtime.configuration.put("templates", request.body, true), 201);
  });
  app.put<{ Params: { id: string }; Body: NotificationTemplate }>("/api/admin/notifications/templates/:id", async (request, reply) => {
    return mutationReply(reply, runtime, () => runtime.configuration.put("templates", { ...request.body, id: request.params.id }, false));
  });
  app.delete<{ Params: { id: string } }>("/api/admin/notifications/templates/:id", async (request, reply) => {
    return mutationReply(reply, runtime, () => runtime.configuration.remove("templates", request.params.id));
  });
}

async function mutationReply(
  reply: { code: (status: number) => { send: (value: unknown) => unknown } },
  runtime: NotificationRuntime,
  action: () => Promise<void>,
  success = 200,
): Promise<unknown> {
  try {
    await action();
    runtime.service.replaceConfiguration(runtime.configuration.configuration());
    return reply.code(success).send({ ok: true });
  } catch (error) {
    return reply.code(400).send({ message: compactError(error) });
  }
}

function isCompleteEvent(event: NotificationEvent | undefined): event is NotificationEvent {
  return Boolean(event?.id && event.type && event.title && event.body && event.occurredAt);
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, " ").slice(0, 500);
}
