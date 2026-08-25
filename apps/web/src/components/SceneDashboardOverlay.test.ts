import { describe, expect, it } from "vitest";
import { parseDashboardMessages } from "./dashboardMessages";

describe("parseDashboardMessages", () => {
  it("accepts the normalized data hub scene message", () => {
    expect(parseDashboardMessages(JSON.stringify({
      source: "tdengine.meters",
      key: "current",
      value: 12.4,
      timestamp: "2026-08-05T10:00:00.000Z",
      sceneId: "scene-1"
    }))).toEqual([{
      source: "tdengine.meters",
      key: "current",
      value: 12.4,
      timestamp: "2026-08-05T10:00:00.000Z",
      sceneId: "scene-1"
    }]);
  });

  it("accepts payload wrappers and rejects heartbeats", () => {
    expect(parseDashboardMessages({ payload: { source: "oracle", key: "status", value: true } })[0]).toMatchObject({ source: "oracle", key: "status", value: true });
    expect(parseDashboardMessages("ping")).toEqual([]);
  });

  it("preserves scene mapping fields for the shared three-dimensional bridge", () => {
    expect(parseDashboardMessages({
      source: "mqtt",
      key: "alarm",
      value: "#ff334f",
      target: { modelId: "model-1", layerId: "layer-2" },
      action: "color"
    })[0]).toMatchObject({ target: { modelId: "model-1", layerId: "layer-2" }, action: "color" });
  });
});
