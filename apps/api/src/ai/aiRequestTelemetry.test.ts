import { describe, expect, it } from "vitest";
import { createAiTelemetryRing, emptyTelemetrySummary, newTelemetryRecord } from "./aiRequestTelemetry.js";

function record(overrides: Partial<Parameters<ReturnType<typeof createAiTelemetryRing>["sink"]>[0]> = {}) {
  return newTelemetryRecord({
    occurredAt: "2026-09-20T00:00:00.000Z",
    source: "assistant",
    providerId: "ai.openai-compatible",
    model: "gpt-5.5",
    servedBy: "primary",
    status: "completed",
    latencyMs: 120,
    ...overrides,
  });
}

describe("AI request telemetry ring", () => {
  it("keeps only the most recent N records", () => {
    const ring = createAiTelemetryRing(3);
    for (let index = 0; index < 5; index += 1) ring.sink(record({ latencyMs: index }));
    const summary = ring.summary();
    expect(summary.records.map((item) => item.latencyMs)).toEqual([2, 3, 4]);
    expect(summary.limit).toBe(3);
  });

  it("aggregates status totals and finds the latest failover event", () => {
    const ring = createAiTelemetryRing(50);
    ring.sink(record());
    ring.sink(record({ servedBy: "fallback", status: "completed", model: "fallback-model" }));
    ring.sink(record({ servedBy: "fallback", status: "completed" }));
    ring.sink(record({ status: "failed", errorCategory: "auth", errorMessage: "HTTP 401" }));
    ring.sink(record({ status: "cancelled" }));
    const summary = ring.summary();
    expect(summary.totals).toEqual({ completed: 3, failed: 1, cancelled: 1, fallbackServed: 2 });
    expect(summary.lastFailover).toMatchObject({ servedBy: "fallback", status: "completed" });
  });

  it("never records API keys or prompt content", () => {
    const ring = createAiTelemetryRing(10);
    ring.sink(record({ errorMessage: "request failed with authorization: Bearer sk-secret-abc" }));
    const serialized = JSON.stringify(ring.summary());
    expect(serialized).not.toContain("sk-secret-abc");
    expect(serialized).not.toContain("apiKey");
  });

  it("reports an empty snapshot for a fresh deployment", () => {
    expect(emptyTelemetrySummary("2026-09-20T00:00:00.000Z")).toMatchObject({
      records: [],
      totals: { completed: 0, failed: 0, cancelled: 0, fallbackServed: 0 },
    });
  });
});
