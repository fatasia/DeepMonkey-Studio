import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DataEvent } from "@bim-studio/contracts";
import { AlertIngestPanel, alertEventToSnapshot, acknowledgeRule, fetchAlertState } from "./AlertIngestPanel";

const states = [
  { ruleId: "temp-high", label: "轴承温度越限", signalId: "bearing-temp", severity: "alarm" as const, status: "active" as const, since: 1, lastValue: 85, acknowledgedAt: null, clearedAt: null },
  { ruleId: "press-low", label: "油压过低", signalId: "oil-press", severity: "warning" as const, status: "cleared" as const, since: 1, lastValue: 0.3, acknowledgedAt: null, clearedAt: 2 },
];
const rules = [{ id: "temp-high", label: "轴承温度越限", signalId: "bearing-temp", kind: "threshold-above", threshold: 80 }];

describe("AlertIngestPanel (P3 UI slice)", () => {
  it("renders rules and active/cleared states with severity tokens", () => {
    const markup = renderToStaticMarkup(<AlertIngestPanel projectId="p1" apiOrigin="http://api.test" locale="zh-CN" authHeaders={{}} />);
    expect(markup).toContain("告警规则与状态");
    expect(markup).toContain("尚未定义告警规则。");
  });

  it("renders hydrated states via fetched data", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => rules })
      .mockResolvedValueOnce({ ok: true, json: async () => states }));
    const { fetchAlertState: load } = await import("./AlertIngestPanel");
    const [loadedRules, loadedStates] = await load("http://api.test", "p1", {});
    expect(loadedRules).toEqual(rules);
    expect(loadedStates).toHaveLength(2);
    vi.unstubAllGlobals();
  });

  it("maps alert bus events to snapshots", () => {
    const event: DataEvent = {
      id: "e1", projectId: "p1", source: "alert-engine", key: "alert/temp-high", action: "alarm",
      value: { state: "active", active: true, severity: "alarm", acknowledged: false, value: 85, ruleId: "temp-high", message: "越限" },
      timestamp: "2026-09-20T00:00:00Z",
    };
    const snapshot = alertEventToSnapshot(event);
    expect(snapshot).toMatchObject({ ruleId: "temp-high", status: "active", severity: "alarm", lastValue: 85 });
  });

  it("acknowledgeRule surfaces non-2xx as an error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409 }));
    await expect(acknowledgeRule("http://api.test", "p1", "temp-high", {})).rejects.toThrow(/409/);
    vi.unstubAllGlobals();
  });

  it("fetchAlertState surfaces a failed channel", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: false, status: 503 }));
    await expect(fetchAlertState("http://api.test", "p1", {})).rejects.toThrow(/503/);
    vi.unstubAllGlobals();
  });
});
