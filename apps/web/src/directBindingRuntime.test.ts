import { describe, expect, it, vi } from "vitest";
import type { DirectBindingSpec } from "@bim-studio/contracts";
import { DirectBindingRuntime, type DirectBindingRuntimeDependencies } from "./directBindingRuntime";

vi.mock("./api", () => ({ api: { executeDirectBinding: vi.fn() }, openDirectBindingWebSocket: vi.fn() }));

class FakeSocket {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  listeners = new Map<string, Array<(event: Event | MessageEvent) => void>>();
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; }
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: Event | MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: Event | MessageEvent = new Event(type)) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
}

describe("DirectBindingRuntime", () => {
  it("polls HTTP immediately, retries after an error, and stops without another request", async () => {
    vi.useFakeTimers();
    const executeHttp = vi.fn()
      .mockResolvedValueOnce({ data: { value: 21 }, value: 21 })
      .mockRejectedValueOnce(new Error("temporary"));
    const values: unknown[] = [];
    const statuses: string[] = [];
    const runtime = new DirectBindingRuntime(httpBinding(), {}, {
      onValue: (value) => values.push(value),
      onStatus: (status) => statuses.push(status)
    }, dependencies({ executeHttp }));

    const stop = runtime.start();
    await vi.waitFor(() => expect(executeHttp).toHaveBeenCalledTimes(1));
    expect(values).toEqual([21]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(executeHttp).toHaveBeenCalledTimes(2);
    expect(statuses).toContain("error");
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(executeHttp).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("subscribes through the same-origin WebSocket, emits values, reconnects, and cleans up", () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const createWebSocket = vi.fn(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const values: unknown[] = [];
    const runtime = new DirectBindingRuntime(websocketBinding(), { equipmentId: "robot-1" }, { onValue: (value) => values.push(value) }, dependencies({ createWebSocket }));

    const stop = runtime.start();
    expect(createWebSocket).toHaveBeenCalledWith("wss://studio.example/api/direct-bindings/ws", ["bim-studio-auth.token"]);
    sockets[0]!.emit("open");
    expect(JSON.parse(sockets[0]!.sent[0]!)).toMatchObject({ type: "subscribe", variables: { equipmentId: "robot-1" } });
    sockets[0]!.emit("message", new MessageEvent("message", { data: JSON.stringify({ type: "data", data: { temperature: 29 }, value: 29 }) }));
    expect(values).toEqual([29]);
    sockets[0]!.emit("close");
    vi.advanceTimersByTime(100);
    expect(createWebSocket).toHaveBeenCalledTimes(2);
    stop();
    expect(sockets[1]!.closed).toBe(true);
    vi.useRealTimers();
  });
});

function dependencies(overrides: Partial<DirectBindingRuntimeDependencies>): DirectBindingRuntimeDependencies {
  return {
    executeHttp: vi.fn(),
    createWebSocket: vi.fn(),
    resolveWebSocketUrl: () => "wss://studio.example/api/direct-bindings/ws",
    authToken: () => "token",
    setTimer: (callback, delay) => Number(setTimeout(callback, delay)),
    clearTimer: (timer) => clearTimeout(timer),
    ...overrides
  };
}

function httpBinding(): DirectBindingSpec {
  return { version: 1, gateway: "server", transport: "http", endpoint: "https://api.example/data", http: { method: "GET", refresh: { intervalMs: 2_000 } } };
}

function websocketBinding(): DirectBindingSpec {
  return { version: 1, gateway: "server", transport: "websocket", endpoint: "wss://events.example/data", websocket: { subscribeMessageTemplate: { equipmentId: "{{equipmentId}}" }, reconnect: { enabled: true, initialDelayMs: 100, maxDelayMs: 1_000, multiplier: 2 } } };
}
