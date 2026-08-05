import { describe, expect, it } from "vitest";
import { DEFAULT_DASHBOARD_STATE, normalizeDashboardState } from "./dashboardState";

describe("normalizeDashboardState", () => {
  it("uses a safe default for legacy scenes", () => {
    expect(normalizeDashboardState(undefined)).toEqual(DEFAULT_DASHBOARD_STATE);
  });

  it("clamps imported layouts and repairs incomplete widgets", () => {
    expect(normalizeDashboardState({ side: "top", width: 2_000, widgets: [{ title: "温度", type: "line", w: 9 }] })).toEqual({
      side: "right",
      width: 720,
      widgets: [{ id: "widget-0", title: "温度", key: "value", type: "line", unit: "", x: 0, y: 0, w: 2, h: 2 }]
    });
  });
});
