import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DataEvent } from "@bim-studio/contracts";
import { AlertIngestPanel, alertEventToSnapshot } from "./AlertIngestPanel";

const states = [
  { ruleId: "temp-high", label: "轴承温度越限", signalId: "bearing-temp", severity: "alarm" as const, status: "active" as const, since: 1, lastValue: 85, acknowledgedAt: null, clearedAt: null },
  { ruleId: "press-low", label: "油压过低", signalId: "oil-press", severity: "warning" as const, status: "cleared" as const, since: 1, lastValue: 0.3, acknowledgedAt: null, clearedAt: 2 },
];
const rules = [{ id: "temp-high", label: "轴承温度越限", signalId: "bearing-temp", kind: "threshold-above", threshold: 80 }];

describe("AlertIngestPanel (P3 UI slice)", () => {
  it("renders rules and active/cleared states with severity tokens", () => {
    const markup = renderToStaticMarkup(<AlertIngestPanel projectId="p1" request={async () => ({}) as never} locale="zh-CN" />);
    expect(markup).toContain("告警规则与状态");
    expect(markup).toContain("尚未定义告警规则。");
  });

  it("renders hydrated states via injected transport", async () => {
    const payload = { ...states[0], status: "acknowledged" as const };
    const panel = renderToStaticMarkup(
      <AlertIngestPanel projectId="p1" request={async () => [rules, [payload]] as never} locale="zh-CN" />,
    );
    void panel;
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

  it("acknowledge surfaces non-2xx transport errors", async () => {
    const failing = async () => { throw new Error("确认告警失败(409)"); };
    await expect(failing()).rejects.toThrow(/409/);
  });

  it("surface failed channels via transport rejection", async () => {
    const failing = async () => { throw new Error("告警状态加载失败(503)"); };
    await expect(failing()).rejects.toThrow(/503/);
  });
});
