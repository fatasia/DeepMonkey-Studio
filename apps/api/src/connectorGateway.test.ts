import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import websocket from "@fastify/websocket";
import { WebSocket, type RawData } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectBindingSpec } from "@bim-studio/contracts";
import { createApiServer } from "./serverOptions.js";
import {
  DirectBindingGatewayError,
  DirectHttpConnectorGateway,
  DirectWebSocketMultiplexer,
  registerDirectBindingRoutes,
  StaticDirectCredentialResolver,
  type DirectWebSocketFactoryContext
} from "./connectorGateway.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function httpBinding(endpoint: string): DirectBindingSpec {
  return {
    version: 1,
    gateway: "server",
    transport: "http",
    endpoint,
    credentialRef: "plant-readonly",
    selection: { jsonPath: "$.data", field: "temperature" },
    http: {
      method: "POST",
      params: { equipment: "{{equipmentId}}" },
      bodyTemplate: { area: "{{area}}", limit: 1 },
      refresh: { intervalMs: 5_000 }
    }
  };
}

async function localHttpServer(handler: Parameters<typeof createServer>[0]): Promise<{ origin: string; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const port = (server.address() as AddressInfo).port;
  return { origin: `http://localhost:${port}`, port };
}

describe("DirectHttpConnectorGateway", () => {
  it("forwards templates and server-side credentials through a DNS-pinned request", async () => {
    const upstream = await localHttpServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          data: { temperature: 26.5 },
          received: {
            query: new URL(request.url!, upstream.origin).searchParams.get("equipment"),
            authorization: request.headers.authorization,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
          }
        }));
      });
    });
    const gateway = new DirectHttpConnectorGateway({
      credentialResolver: new StaticDirectCredentialResolver({ "plant-readonly": { authorization: "Bearer server-secret" } }),
      outboundPolicy: { allowPrivateNetwork: true, allowedPorts: [upstream.port], allowedHostnames: ["localhost"] },
      resolveHost: async () => [{ address: "127.0.0.1", family: 4 }]
    });

    const result = await gateway.execute(httpBinding(`${upstream.origin}/telemetry`), { equipmentId: "robot-7", area: "A1" });

    expect(result.value).toBe(26.5);
    expect(result.data).toMatchObject({
      received: { query: "robot-7", authorization: "Bearer server-secret", body: { area: "A1", limit: 1 } }
    });
  });

  it("rejects private DNS answers unless private access and a hostname allowlist are both explicit", async () => {
    const binding = httpBinding("https://telemetry.example.test/current");
    const withoutPrivateAccess = new DirectHttpConnectorGateway({
      resolveHost: async () => [{ address: "10.10.0.8", family: 4 }]
    });
    const withoutAllowlist = new DirectHttpConnectorGateway({
      outboundPolicy: { allowPrivateNetwork: true },
      resolveHost: async () => [{ address: "10.10.0.8", family: 4 }]
    });

    await expect(withoutPrivateAccess.execute(binding)).rejects.toMatchObject({ code: "OUTBOUND_DENIED" });
    await expect(withoutAllowlist.execute(binding)).rejects.toMatchObject({ code: "OUTBOUND_DENIED" });
  });

  it("rejects a DNS response containing a private rebinding address", async () => {
    const gateway = new DirectHttpConnectorGateway({
      resolveHost: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 }
      ]
    });

    await expect(gateway.execute(httpBinding("https://example.com/current"))).rejects.toEqual(
      expect.objectContaining<Partial<DirectBindingGatewayError>>({ code: "OUTBOUND_DENIED" })
    );
  });

  it("exposes one same-origin HTTP route with a unified error envelope", async () => {
    const app = createApiServer();
    await app.register(websocket);
    const httpGateway = new DirectHttpConnectorGateway({ resolveHost: async () => [{ address: "127.0.0.1", family: 4 }] });
    const webSockets = new DirectWebSocketMultiplexer({ resolveHost: async () => [{ address: "93.184.216.34", family: 4 }] });
    await registerDirectBindingRoutes(app, { httpGateway, webSockets });
    closers.push(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/api/direct-bindings/http",
      payload: { binding: httpBinding("http://localhost:8080/current") }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: { code: "OUTBOUND_DENIED", message: "不允许访问端口 8080", retryable: false }
    });
  });
});

class MockUpstreamSocket extends EventEmitter {
  readyState = WebSocket.CONNECTING;
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = WebSocket.CLOSED; }
  open(): void { this.readyState = WebSocket.OPEN; this.emit("open"); }
  message(data: unknown): void { this.emit("message", Buffer.from(JSON.stringify(data)) as RawData); }
}

function websocketBinding(): DirectBindingSpec {
  return {
    version: 1,
    gateway: "server",
    transport: "websocket",
    endpoint: "wss://events.example.com/telemetry",
    selection: { field: "temperature" },
    websocket: {
      protocols: ["telemetry.v1"],
      subscribeMessageTemplate: { type: "subscribe", equipment: "{{equipmentId}}" },
      reconnect: { enabled: true, initialDelayMs: 10, maxDelayMs: 100, multiplier: 2 }
    }
  };
}

describe("DirectWebSocketMultiplexer", () => {
  it("shares one upstream subscription across consumers and closes it after the last unsubscribe", async () => {
    const sockets: MockUpstreamSocket[] = [];
    const factory = vi.fn((_context: DirectWebSocketFactoryContext) => {
      const socket = new MockUpstreamSocket();
      sockets.push(socket);
      return socket;
    });
    const multiplexer = new DirectWebSocketMultiplexer({
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }]
    }, factory);
    const first: unknown[] = [];
    const second: unknown[] = [];
    const binding = websocketBinding();

    const unsubscribeFirst = multiplexer.subscribe(binding, { equipmentId: "robot-1" }, { onMessage: (data) => first.push(data) });
    const unsubscribeSecond = multiplexer.subscribe(binding, { equipmentId: "robot-1" }, { onMessage: (data) => second.push(data) });
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    sockets[0]!.open();
    sockets[0]!.message({ temperature: 28 });

    expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: "subscribe", equipment: "robot-1" })]);
    expect(first).toEqual([{ temperature: 28 }]);
    expect(second).toEqual([{ temperature: 28 }]);
    unsubscribeFirst();
    expect(multiplexer.upstreamCount).toBe(1);
    unsubscribeSecond();
    expect(multiplexer.upstreamCount).toBe(0);
    expect(sockets[0]!.closed).toBe(true);
  });

  it("serves the same-origin WebSocket route and returns selected upstream values", async () => {
    const upstream = new MockUpstreamSocket();
    const multiplexer = new DirectWebSocketMultiplexer({
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }]
    }, () => upstream);
    const app = createApiServer();
    await app.register(websocket);
    await registerDirectBindingRoutes(app, { httpGateway: new DirectHttpConnectorGateway(), webSockets: multiplexer });
    await app.listen({ host: "127.0.0.1", port: 0 });
    closers.push(() => app.close());
    const port = (app.server.address() as AddressInfo).port;
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/direct-bindings/ws`);
    closers.push(async () => client.close());
    const messages: Array<Record<string, unknown>> = [];
    client.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });

    client.send(JSON.stringify({ type: "subscribe", requestId: "request-1", binding: websocketBinding(), variables: { equipmentId: "robot-2" } }));
    await vi.waitFor(() => expect(messages.some((message) => message.type === "subscribed")).toBe(true));
    upstream.open();
    upstream.message({ temperature: 31, status: "online" });
    await vi.waitFor(() => expect(messages.some((message) => message.type === "data")).toBe(true));

    expect(messages).toContainEqual(expect.objectContaining({
      type: "data", requestId: "request-1", value: 31,
      data: { temperature: 31, status: "online" }
    }));
  });
});
