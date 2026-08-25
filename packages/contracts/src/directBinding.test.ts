import { describe, expect, it } from "vitest";
import { assertDirectBindingSpec, type DirectBindingSpec } from "./directBinding.js";

const httpBinding: DirectBindingSpec = {
  version: 1,
  gateway: "server",
  transport: "http",
  endpoint: "https://api.example.com/v1/telemetry",
  credentialRef: "plant-api-readonly",
  selection: { jsonPath: "$.data.items[0]", field: "temperature" },
  http: {
    method: "POST",
    params: { equipment: "{{equipmentId}}", limit: 1 },
    bodyTemplate: { query: { area: "{{area}}" } },
    refresh: { intervalMs: 5_000, immediate: true }
  }
};

describe("assertDirectBindingSpec", () => {
  it("accepts a server-gateway HTTP binding whose access defaults to read-only", () => {
    expect(() => assertDirectBindingSpec(httpBinding)).not.toThrow();
    expect(httpBinding.access ?? "read-only").toBe("read-only");
  });

  it("accepts a reconnecting WebSocket binding", () => {
    expect(() => assertDirectBindingSpec({
      version: 1,
      gateway: "server",
      transport: "websocket",
      endpoint: "wss://events.example.com/equipment",
      websocket: {
        protocols: ["telemetry.v1"],
        subscribeMessageTemplate: { type: "subscribe", equipmentId: "{{equipmentId}}" },
        reconnect: { enabled: true, initialDelayMs: 250, maxDelayMs: 10_000, multiplier: 2 }
      }
    })).not.toThrow();
  });

  it.each([
    { ...httpBinding, gateway: "browser" },
    { ...httpBinding, transport: "websocket" },
    { ...httpBinding, http: { ...httpBinding.http!, refresh: { intervalMs: 0 } } },
    { ...httpBinding, access: "write" }
  ])("rejects unsafe or incomplete bindings", (binding) => {
    expect(() => assertDirectBindingSpec(binding)).toThrow();
  });
});
