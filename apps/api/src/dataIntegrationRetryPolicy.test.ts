import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataConnectionRecord, DataDatasetRecord } from "@bim-studio/contracts";
import { listConnectorDiagnostics, previewDataset } from "./dataIntegration.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("data integration retry policy", () => {
  it("stops after the configured retry budget and records the source offline", async () => {
    const request = vi.fn(async () => new Response("busy", { status: 503, statusText: "Busy" }));
    vi.stubGlobal("fetch", request);
    const source = connection("bounded-offline", { retryAttempts: 2, retryDelayMs: 100, retryMaxDelayMs: 100, retryMultiplier: 2, retryJitter: 0 });

    await expect(previewDataset({ port: 4100 } as never, source, dataset())).rejects.toThrow("HTTP 503");

    expect(request).toHaveBeenCalledTimes(3);
    expect(listConnectorDiagnostics("retry-project")).toContainEqual(expect.objectContaining({
      connectionId: source.id,
      status: "offline",
      consecutiveFailures: 1,
    }));
  });

  it("does not retry authentication failures", async () => {
    const request = vi.fn(async () => new Response("unauthorized", { status: 401, statusText: "Unauthorized" }));
    vi.stubGlobal("fetch", request);
    const source = connection("auth-failure", { retryAttempts: 5, retryDelayMs: 100 });

    await expect(previewDataset({ port: 4100 } as never, source, dataset())).rejects.toThrow("HTTP 401");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("uses safe defaults when optional backoff values are malformed", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503, statusText: "Busy" }))
      .mockResolvedValueOnce(new Response('{"items":[{"value":7}]}', { status: 200 }));
    vi.stubGlobal("fetch", request);
    const source = connection("malformed-backoff", {
      retryAttempts: 1,
      retryDelayMs: 100,
      retryMaxDelayMs: "invalid" as never,
      retryMultiplier: "invalid" as never,
      retryJitter: "invalid" as never,
    });

    await expect(previewDataset({ port: 4100 } as never, source, dataset())).resolves.toMatchObject({ rows: [{ value: 7 }] });
    expect(request).toHaveBeenCalledTimes(2);
  });
});

function connection(id: string, config: Record<string, unknown>): DataConnectionRecord {
  return {
    id,
    projectId: "retry-project",
    name: id,
    type: "http",
    enabled: true,
    config: { url: "https://telemetry.example.test/items", ...config },
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  };
}

function dataset(): DataDatasetRecord {
  return {
    id: "retry-dataset",
    projectId: "retry-project",
    connectionId: "retry-connection",
    name: "弱网数据",
    sourceKey: "items",
    refreshSeconds: 0,
    fields: [],
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  };
}
