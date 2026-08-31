import { describe, expect, it } from "vitest";
import { directSceneDataBindingMessage, normalizeSceneDataBindings, sceneDataBindingMessage } from "./sceneDataBindings";

describe("scene data bindings", () => {
  it("normalizes one shared pipeline binding and clamps its polling budget", () => {
    expect(normalizeSceneDataBindings([{
      id: "binding-1",
      name: "设备透明度",
      enabled: true,
      pipelineId: "pipeline-devices",
      field: "opacity",
      target: { modelId: "robot-1" },
      action: "opacity",
      refreshSeconds: 1
    }])[0]).toMatchObject({ pipelineId: "pipeline-devices", field: "opacity", refreshSeconds: 2 });
  });

  it("turns a pipeline row into the same scene data message used by WebSocket data", () => {
    const binding = normalizeSceneDataBindings([{
      id: "binding-1",
      name: "设备透明度",
      enabled: true,
      pipelineId: "pipeline-devices",
      field: "opacity",
      target: { modelId: "robot-1", layerId: "arm" },
      action: "opacity",
      refreshSeconds: 5
    }])[0]!;
    const message = sceneDataBindingMessage(binding, { fields: [{ key: "opacity", label: "透明度", type: "number" }], rows: [{ opacity: 1.8 }] }, "scene-1", "2026-08-25T00:00:00.000Z");

    expect(message).toEqual({
      source: "pipeline:pipeline-devices",
      key: "opacity",
      value: 1,
      timestamp: "2026-08-25T00:00:00.000Z",
      sceneId: "scene-1",
      target: { modelId: "robot-1", layerId: "arm" },
      action: "opacity"
    });
  });

  it("rejects ambiguous bindings that select both product kinds", () => {
    expect(normalizeSceneDataBindings([{ id: "bad", enabled: true, datasetId: "a", pipelineId: "b", field: "x", target: { modelId: "m" }, action: "color", refreshSeconds: 5 }])).toEqual([]);
  });

  it("normalizes a direct binding and turns its value into the same 3D data event chain", () => {
    const binding = normalizeSceneDataBindings([{
      id: "direct-1", name: "设备显隐", enabled: true, field: "online",
      directBinding: { version: 1, gateway: "server", transport: "http", endpoint: "https://api.example/status", http: { method: "GET", refresh: { intervalMs: 5_000 } } },
      target: { modelId: "robot-1" }, action: "visibility", refreshSeconds: 5
    }])[0]!;

    expect(binding.directBinding?.gateway).toBe("server");
    expect(directSceneDataBindingMessage(binding, "false", "scene-1", "2026-08-25T00:00:00.000Z")).toMatchObject({
      source: "direct:direct-1", key: "online", value: false, sceneId: "scene-1", target: { modelId: "robot-1" }, action: "visibility"
    });
  });

  it("preserves a fire patch from pipeline data for the shared effects runtime", () => {
    const binding = normalizeSceneDataBindings([{
      id: "fire-binding", name: "火焰告警", enabled: true, pipelineId: "alarm-pipeline",
      field: "fire", target: { modelId: "tank-1" }, action: "effects", refreshSeconds: 5,
    }])[0]!;
    const message = sceneDataBindingMessage(binding, {
      fields: [{ key: "fire", label: "火焰", type: "json" }],
      rows: [{ fire: { fire: { enabled: true, intensity: 3.5 } } }],
    }, "scene-1");

    expect(message.value).toEqual({ fire: { enabled: true, intensity: 3.5 } });
    expect(message.action).toBe("effects");
  });

  it("normalizes a safe scalar PBR patch and rejects texture injection", () => {
    const binding = normalizeSceneDataBindings([{
      id: "material-binding", name: "温升材质", enabled: true, pipelineId: "thermal-pipeline",
      field: "material", target: { modelId: "motor-1" }, action: "material", refreshSeconds: 5,
    }])[0]!;
    const message = sceneDataBindingMessage(binding, {
      fields: [{ key: "material", label: "材质", type: "json" }],
      rows: [{ material: { color: "#ff7a45", roughness: 0.35, emissiveIntensity: 1.4 } }],
    }, "scene-1");

    expect(message.value).toEqual({ color: "#ff7a45", roughness: 0.35, emissiveIntensity: 1.4 });
    expect(() => sceneDataBindingMessage(binding, {
      fields: [{ key: "material", label: "材质", type: "json" }],
      rows: [{ material: { baseColorMapUrl: "https://untrusted.test/map.png" } }],
    }, "scene-1")).toThrow("不支持参数");
  });
});
