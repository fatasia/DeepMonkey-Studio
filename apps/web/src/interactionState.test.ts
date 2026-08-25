import { describe, expect, it } from "vitest";
import { defaultInteractionCode, normalizeInteractionScripts, sameInteractionTarget } from "./interactionState";

describe("scene interaction state", () => {
  it("keeps valid object and dashboard widget scripts", () => {
    expect(normalizeInteractionScripts([
      { id: "object-click", name: "点击", target: { kind: "object", modelId: "model-1", layerId: "layer-2" }, trigger: "click", enabled: true, code: "ctx.target.object.visible = false" },
      { id: "widget-load", name: "加载", target: { kind: "widget", widgetId: "widget-1" }, trigger: "load", enabled: false, code: "console.log(ctx.target.widget)" }
    ])).toHaveLength(2);
  });

  it("drops malformed targets and unsupported triggers from imported scenes", () => {
    expect(normalizeInteractionScripts([
      { target: { kind: "object", modelId: "" }, trigger: "click" },
      { target: { kind: "widget", widgetId: "widget-1" }, trigger: "unknown" }
    ])).toEqual([]);
  });

  it("keeps explicit action targets and application actions", () => {
    const [script] = normalizeInteractionScripts([{ target: { kind: "widget", widgetId: "widget-1" }, trigger: "click", actions: [
      { id: "jump", type: "navigateScene", enabled: true, sceneId: "scene-2" },
      { id: "hide", type: "visibility", enabled: true, target: { kind: "object", modelId: "model-1", layerId: "wall-7" }, value: "hide" }
    ] }]);
    expect(script?.actions).toEqual([{ id: "jump", type: "navigateScene", enabled: true, sceneId: "scene-2" }]);
    const [objectScript] = normalizeInteractionScripts([{ target: { kind: "object", modelId: "model-1" }, trigger: "click", actions: [{ id: "hide", type: "visibility", enabled: true, target: { kind: "object", modelId: "model-2", layerId: "wall-7" }, value: "hide" }] }]);
    expect(objectScript?.actions?.[0]?.target).toEqual({ kind: "object", modelId: "model-2", layerId: "wall-7" });
  });

  it("generates documented trusted-script context and compares exact targets", () => {
    expect(defaultInteractionCode("pointerEnter")).toContain("ctx.engine");
    expect(defaultInteractionCode("pointerEnter")).toContain("THREE");
    expect(sameInteractionTarget(
      { kind: "object", modelId: "model-1", layerId: "layer-1" },
      { kind: "object", modelId: "model-1", layerId: "layer-1" }
    )).toBe(true);
    expect(sameInteractionTarget(
      { kind: "widget", widgetId: "widget-1" },
      { kind: "widget", widgetId: "widget-2" }
    )).toBe(false);
  });
});
