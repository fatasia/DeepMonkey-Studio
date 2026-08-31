import type { FastifyInstance } from "fastify";
import type { DirectBindingSpec } from "@bim-studio/contracts";
import {
  DirectBindingGatewayError,
  type DirectBindingVariables,
  type DirectHttpConnectorGateway,
  type DirectWebSocketMultiplexer,
  selectDirectBindingValue
} from "./connectorGateway.js";

export interface DirectBindingRouteDependencies {
  httpGateway: DirectHttpConnectorGateway;
  webSockets: DirectWebSocketMultiplexer;
}

export async function registerDirectBindingRoutes(app: FastifyInstance, dependencies: DirectBindingRouteDependencies): Promise<void> {
  app.post<{ Body: { binding?: DirectBindingSpec; variables?: DirectBindingVariables } }>(
    "/api/direct-bindings/http",
    async (request, reply) => {
      try {
        return await dependencies.httpGateway.execute(request.body?.binding as DirectBindingSpec, request.body?.variables ?? {});
      } catch (reason) {
        const error = normalizeRouteError(reason);
        return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, retryable: error.retryable } });
      }
    }
  );

  app.get("/api/direct-bindings/ws", { websocket: true }, (socket) => {
    let unsubscribe: (() => void) | undefined;
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as { type?: string; requestId?: string; binding?: DirectBindingSpec; variables?: DirectBindingVariables };
        if (message.type !== "subscribe" || !message.binding) throw new DirectBindingGatewayError("INVALID_BINDING", "需要 subscribe 消息和 binding", 400, false);
        unsubscribe?.();
        unsubscribe = dependencies.webSockets.subscribe(message.binding, message.variables ?? {}, {
          onMessage: (data) => sendClient(socket, {
            type: "data", requestId: message.requestId,
            data, value: selectDirectBindingValue(data, message.binding!)
          }),
          onState: (state) => sendClient(socket, { type: "state", requestId: message.requestId, state })
        });
        sendClient(socket, { type: "subscribed", requestId: message.requestId });
      } catch (reason) {
        const error = normalizeRouteError(reason);
        sendClient(socket, { type: "error", error: { code: error.code, message: error.message, retryable: error.retryable } });
      }
    });
    socket.once("close", () => unsubscribe?.());
    socket.once("error", () => unsubscribe?.());
  });

  app.addHook("onClose", async () => dependencies.webSockets.close());
}

function sendClient(socket: { readyState: number; OPEN: number; send(data: string): void }, message: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function normalizeRouteError(reason: unknown): DirectBindingGatewayError {
  if (reason instanceof DirectBindingGatewayError) return reason;
  return new DirectBindingGatewayError("INVALID_BINDING", reason instanceof Error ? reason.message : "直接绑定请求无效", 400, false, { cause: reason });
}
