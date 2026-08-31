import { describe, expect, it } from "vitest";
import type { ApplicationDocument } from "@bim-studio/contracts";
import { buildSceneScriptContext, buildSceneScriptTypeDeclarations, resolvePreferredScriptTarget } from "./sceneScriptContext";

describe("buildSceneScriptContext", () => {
  it("prefers the selected 2D widget and keeps a 3D fallback", () => {
    const targets = [
      { id: "widget-1", name: "温度卡片", kind: "component" as const, context: "生产总览" },
      { id: "object-1", name: "设备 001", kind: "object" as const, context: "产线" },
    ];

    expect(resolvePreferredScriptTarget(targets, [{ kind: "widget", id: "widget-1" }], targets[1])).toEqual(targets[0]);
    expect(resolvePreferredScriptTarget(targets, [], targets[1])).toEqual(targets[1]);
  });
  it("collects stable objects, components, data keys and Unity events", () => {
    const application = {
      data: { variables: [{ id: "plant.temperature", value: 21 }] },
      scenes: [{ id: "scene-1", name: "Factory", cameraViews: [{ id: "view-overview", name: "Overview" }], models: [{ modelId: "pump-01", name: "Pump 01" }], primitives: [] }],
      pages: [{ id: "page-1", name: "Overview", nodes: [
        { id: "gauge-1", kind: "data-widget", name: "Temperature", widget: { title: "Gauge", key: "device.temp", field: "value", unityEventNames: ["device-click"] } },
        { id: "unity-1", kind: "data-widget", name: "Virtual line", widget: { title: "Unity", key: "", type: "unity" } },
      ] }],
      interactions: [{ trigger: "valueChange" }]
    } as unknown as ApplicationDocument;

    const context = buildSceneScriptContext(application);
    expect(context.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "pump-01", kind: "object", context: "Factory" }),
      expect.objectContaining({ id: "gauge-1", kind: "component", context: "Overview" }),
      expect.objectContaining({ id: "unity-1", kind: "component", runtime: "unity" }),
    ]));
    expect(context.dataKeys).toEqual(expect.arrayContaining(["plant.temperature", "device.temp", "value", "unity.device.temp.device-click"]));
    expect(context.eventNames).toEqual(expect.arrayContaining(["click", "device-click", "valueChange"]));
    expect(context.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "scene-1", kind: "scene" }),
      expect.objectContaining({ id: "page-1", kind: "page" }),
      expect.objectContaining({ id: "view-overview", kind: "cameraView", context: "Factory" })
    ]));

    const declarations = buildSceneScriptTypeDeclarations(context);
    expect(declarations).toContain('object: "pump-01";');
    expect(declarations).toContain('component: "gauge-1" | "unity-1";');
    expect(declarations).toContain('unityComponent: "unity-1";');
    expect(declarations).toContain('scene: "scene-1";');
    expect(declarations).toContain('page: "page-1";');
    expect(declarations).toContain('cameraView: "view-overview";');
    expect(declarations).toContain('"device-click": true;');
  });
});
