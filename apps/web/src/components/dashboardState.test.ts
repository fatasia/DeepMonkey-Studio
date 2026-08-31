import { describe, expect, it } from "vitest";
import { DEFAULT_DASHBOARD_STATE, normalizeDashboardState } from "./dashboardState";

describe("normalizeDashboardState", () => {
  it("uses a safe default for legacy scenes", () => {
    expect(normalizeDashboardState(undefined)).toEqual(DEFAULT_DASHBOARD_STATE);
    expect(normalizeDashboardState(undefined).widgets).toEqual([]);
    expect(normalizeDashboardState({ side: "right" }).widgets).toEqual([]);
  });

  it("preserves an embedded topology reference", () => {
    expect(normalizeDashboardState({ widgets: [{ id: "topology", title: "产线拓扑", type: "topology", topologyId: "topology:line" }] }).widgets[0]).toMatchObject({
      type: "topology",
      topologyId: "topology:line"
    });
  });

  it("clamps imported layouts and repairs incomplete widgets", () => {
    expect(normalizeDashboardState({ side: "top", width: 2_000, widgets: [{ title: "温度", type: "line", w: 9 }] })).toEqual({
      side: "right",
      width: 720,
      widgets: [{ id: "widget-0", title: "温度", key: "value", type: "line", unit: "", x: 0, y: 0, w: 2, h: 2 }]
    });
  });

  it("keeps an embedded web page while limiting imported layout values", () => {
    expect(normalizeDashboardState({ widgets: [{ id: "web", title: "能耗页面", key: "", type: "url", url: "https://example.com/energy", h: 99 }] }).widgets[0]).toEqual({
      id: "web",
      title: "能耗页面",
      key: "value",
      type: "url",
      unit: "",
      x: 0,
      y: 0,
      w: 1,
      h: 8,
      url: "https://example.com/energy"
    });
  });

  it("preserves local video and live monitor playback settings", () => {
    const state = normalizeDashboardState({ widgets: [
      { id: "video", title: "宣传片", type: "video", key: "value", videoUrl: "/assets/demo.mp4", videoFit: "cover", videoAutoplay: true, videoMuted: false, videoLoop: false },
      { id: "monitor", title: "门厅监控", type: "monitor", key: "value", videoUrl: "http://localhost:8888/cam/index.m3u8", monitorSourceUrl: "rtsp://camera/live", monitorProtocol: "hls" }
    ] });
    expect(state.widgets[0]).toMatchObject({ type: "video", videoUrl: "/assets/demo.mp4", videoFit: "cover", videoAutoplay: true, videoMuted: false, videoLoop: false, h: 3 });
    expect(state.widgets[1]).toMatchObject({ type: "monitor", monitorSourceUrl: "rtsp://camera/live", monitorProtocol: "hls", h: 3 });
  });

  it("preserves a pipeline field as a first-class dashboard binding", () => {
    const state = normalizeDashboardState({ widgets: [{
      id: "throughput",
      title: "节拍",
      type: "value",
      key: "pipeline-cycle.cycle_time",
      pipelineId: "pipeline-cycle",
      field: "cycle_time"
    }] });

    expect(state.widgets[0]).toMatchObject({
      pipelineId: "pipeline-cycle",
      field: "cycle_time",
      key: "pipeline-cycle.cycle_time"
    });
  });
});
