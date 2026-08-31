import { describe, expect, it } from "vitest";
import pureFixture from "../../../test-fixtures/scene-v1-pure-3d.json";
import { migrateSceneSnapshotV1, type SceneSnapshot } from "@bim-studio/contracts";
import { evaluateApplicationInteraction, sameObjectRef } from "./interactionRuntime.js";

function document() {
  return migrateSceneSnapshotV1(pureFixture as SceneSnapshot);
}

describe("application interaction runtime", () => {
  it("matches stable object references and separates data updates from host effects", () => {
    const application = document();
    const source = { kind: "widget", id: application.pages[0]!.nodes[0]!.id } as const;
    application.interactions = [{
      id: "flow:widget-to-scene",
      name: "组件控制场景",
      source,
      trigger: "click",
      enabled: true,
      actions: [
        { id: "set-line", type: "setData", enabled: true, dataKey: "line.selected", value: "A" },
        { id: "camera", type: "cameraView", enabled: true, cameraViewId: "view:overview" }
      ]
    }];

    const result = evaluateApplicationInteraction(application, {
      source,
      trigger: "click",
      timestamp: "2026-08-25T00:00:00.000Z"
    });

    expect(result.selection).toEqual([source]);
    expect(result.matchedFlowIds).toEqual(["flow:widget-to-scene"]);
    expect(result.variableUpdates).toEqual({ "line.selected": "A" });
    expect(result.effects).toEqual([expect.objectContaining({
      flowId: "flow:widget-to-scene",
      action: expect.objectContaining({ type: "cameraView", cameraViewId: "view:overview" })
    })]);
  });

  it("ignores disabled and unrelated flows", () => {
    const application = document();
    application.interactions = [{
      id: "flow:disabled",
      name: "已禁用",
      source: { kind: "widget", id: application.pages[0]!.nodes[0]!.id },
      trigger: "click",
      enabled: false,
      actions: [{ id: "message", type: "message", enabled: true, message: "不应执行" }]
    }];

    const result = evaluateApplicationInteraction(application, {
      source: { kind: "scene", id: application.scenes[0]!.id },
      trigger: "click",
      timestamp: "2026-08-25T00:00:00.000Z"
    });

    expect(result.effects).toEqual([]);
    expect(result.matchedFlowIds).toEqual([]);
    expect(result.variableUpdates).toEqual({});
  });

  it("maps a clicked data-point payload into a drill-down parameter", () => {
    const source = document();
    source.interactions = [{ id: "drill", name: "钻取", enabled: true, source: { kind: "widget", id: "chart-1" }, trigger: "click", actions: [{ id: "open", type: "dashboard", enabled: true, dashboardPageId: source.pages[0]?.id, dataKey: "selected.device", value: "$event.data.id" }] }];
    const result = evaluateApplicationInteraction(source, { source: { kind: "widget", id: "chart-1" }, trigger: "click", timestamp: "2026-08-26T00:00:00.000Z", payload: { data: { id: "M-01" } } });
    expect(result.variableUpdates["selected.device"]).toBe("M-01");
    expect(result.effects[0]?.action.type).toBe("dashboard");
  });

  it("compares page/widget/scene and object references without cross-kind matches", () => {
    expect(sameObjectRef({ kind: "widget", id: "one" }, { kind: "widget", id: "one" })).toBe(true);
    expect(sameObjectRef({ kind: "widget", id: "one" }, { kind: "scene", id: "one" })).toBe(false);
    expect(sameObjectRef(
      { kind: "object", sceneId: "scene", modelId: "model", layerId: "layer" },
      { kind: "object", sceneId: "scene", modelId: "model", layerId: "layer" }
    )).toBe(true);
  });
});
