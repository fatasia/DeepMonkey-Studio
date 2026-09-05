import { describe, expect, it } from "vitest";
import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";
import { publicWidgetRestriction } from "./publicPlaybackPolicy";
const widget: DashboardDataWidgetConfig = { type: "value", title: "数据", key: "a", unit: "" };
describe("public playback policy", () => {
  it("shows a real unavailable state for protected data but permits script values", () => {
    expect(publicWidgetRestriction({ ...widget, datasetId: "private" }, false)).toContain("受保护数据");
    expect(publicWidgetRestriction({ ...widget, datasetId: "private" }, true)).toBeUndefined();
    expect(publicWidgetRestriction(widget, false)).toBeUndefined();
  });
  it("keeps public media usable without enabling protected gateway resolution", () => {
    expect(publicWidgetRestriction({ ...widget, type: "monitor", monitorSourceUrl: "rtsp://camera" }, false)).toContain("媒体网关");
    expect(publicWidgetRestriction({ ...widget, type: "monitor", videoUrl: "/assets/movie.mp4" }, false)).toBeUndefined();
    expect(publicWidgetRestriction({ ...widget, type: "map", map: { geoJsonUrl: "/assets/map.json" } } as DashboardDataWidgetConfig, false)).toBeUndefined();
  });
});
