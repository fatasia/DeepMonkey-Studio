import { describe, expect, it, vi } from "vitest";
import { createAlertIngestApi } from "./alertIngestApi";

describe("alert ingest API client", () => {
  it("unwraps the alert-state response envelope used by the production API", async () => {
    const state = {
      ruleId: "temperature-high",
      label: "高温",
      signalId: "temperature",
      severity: "alarm" as const,
      status: "active" as const,
      since: 1,
      lastValue: 91,
      acknowledgedAt: null,
      clearedAt: null,
    };
    const request = vi.fn().mockResolvedValue({ ok: true, states: [state] });

    await expect(createAlertIngestApi(request).fetchState("plant/a")).resolves.toEqual([state]);
    expect(request).toHaveBeenCalledWith("/api/projects/plant%2Fa/alert-state");
  });

  it("encodes project and rule identities for mutating operations", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    const api = createAlertIngestApi(request);

    await api.acknowledge("plant/a", "rule 1");
    await api.removeRule("plant/a", "rule 1");

    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "/api/projects/plant%2Fa/alert-rules/rule%201/acknowledge",
      "/api/projects/plant%2Fa/alert-rules/rule%201",
    ]);
  });
});
