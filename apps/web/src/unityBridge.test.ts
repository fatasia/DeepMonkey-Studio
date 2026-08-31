import { describe, expect, it } from "vitest";
import {
  parseUnityBuildManifest,
  readUnityBridgeEvent,
  reconcileUnityVersionWidget,
  resolveUnityDataLayers,
  unityHostMessage,
  unityTargetOrigin,
} from "./unityBridge";

describe("Unity WebGL bridge", () => {
  it("builds versioned host messages and validates Unity events", () => {
    expect(unityHostMessage("scene", "widget-1", "Factory", "message-1", 100)).toEqual({
      source: "bim-studio",
      version: 1,
      type: "scene",
      widgetId: "widget-1",
      messageId: "message-1",
      sentAt: 100,
      payload: "Factory",
    });
    expect(
      readUnityBridgeEvent({
        source: "unity-webgl",
        version: 1,
        type: "event",
        eventName: "device-click",
        payload: { id: "M-01" },
      }),
    ).toMatchObject({ eventName: "device-click" });
    expect(readUnityBridgeEvent({ source: "unity-webgl", version: 1, type: "event" })).toBeUndefined();
    expect(
      readUnityBridgeEvent({
        source: "unity-webgl",
        version: 1,
        type: "ack",
        messageId: "message-1",
        messageType: "scene",
      }),
    ).toMatchObject({ messageId: "message-1" });
    expect(
      readUnityBridgeEvent({ source: "unity-webgl", version: 1, type: "health", fps: 59.8, scene: "Factory" }),
    ).toMatchObject({ fps: 59.8 });
    expect(
      readUnityBridgeEvent({
        source: "unity-webgl",
        version: 1,
        type: "capabilities",
        capabilities: ["ack", "unknown-capability", 42, "heartbeat"],
      }),
    ).toMatchObject({ capabilities: ["ack", "heartbeat"] });
    expect(
      readUnityBridgeEvent({ source: "unity-webgl", version: 1, type: "ready", widgetId: 42 }),
    ).toBeUndefined();
  });

  it("resolves live data layers from variables, filters, and bound dataset context", () => {
    expect(
      resolveUnityDataLayers(
        [
          { layerKey: "temperature", dataKey: "device.temperature" },
          { layerKey: "region", dataKey: "filters.region" },
          { layerKey: "rows", dataKey: "data.rows" },
        ],
        { "device.temperature": 28.5 },
        { region: "华东" },
        { value: 2, rows: [{ id: "P-01" }] },
      ),
    ).toEqual({ temperature: 28.5, region: "华东", rows: [{ id: "P-01" }] });
  });

  it("uses an explicit origin or derives it from the player URL", () => {
    expect(unityTargetOrigin("https://unity.example.com/player/index.html")).toBe("https://unity.example.com");
    expect(unityTargetOrigin("https://unity.example.com", "https://cdn.example.com/build")).toBe(
      "https://cdn.example.com",
    );
    expect(unityTargetOrigin("javascript:alert(1)")).toBeUndefined();
  });

  it("parses a reusable version-neutral build manifest and resolves its player URL", () => {
    expect(
      parseUnityBuildManifest(
        {
          schemaVersion: 1,
          bridgeVersion: 1,
          playerUrl: "./index.html",
          unityVersion: "Unity 6",
          scenes: ["Factory"],
          events: ["device-click"],
          dataLayers: [{ key: "telemetry", keyField: "id", target: "Assets" }],
          actions: ["focus"],
          objects: [{ id: "pump-1", name: "Pump 1" }],
          properties: [{ key: "speed", type: "number", target: "pump-1" }],
          runtimeCapabilities: ["ack", "heartbeat"],
        },
        "https://cdn.example.com/build/manifest.json",
      ),
    ).toMatchObject({
      playerUrl: "https://cdn.example.com/build/index.html",
      unityVersion: "Unity 6",
      scenes: ["Factory"],
      events: ["device-click"],
      dataLayers: [{ key: "telemetry", keyField: "id", target: "Assets" }],
      actions: ["focus"],
      objects: [{ id: "pump-1" }],
      properties: [{ key: "speed", type: "number" }],
      runtimeCapabilities: ["ack", "heartbeat"],
    });
    expect(() =>
      parseUnityBuildManifest(
        { schemaVersion: 1, bridgeVersion: 2, playerUrl: "./index.html" },
        "https://cdn.example.com/manifest.json",
      ),
    ).toThrow(/Unsupported/);
  });

  it("reconciles imported versions and auto-binds matching data-layer names", () => {
    const version = {
      id: "v2",
      resourceId: "unity-1",
      version: 2,
      sourceFileName: "factory.zip",
      contentHash: "hash",
      size: 100,
      fileCount: 4,
      playerUrl: "/assets/factory/index.html",
      manifestUrl: "/assets/factory/bim-studio.manifest.json",
      diagnostics: [],
      createdAt: "2026-01-01",
      manifest: {
        schemaVersion: 1 as const,
        bridgeVersion: 1 as const,
        playerUrl: "index.html",
        scenes: ["Factory"],
        actions: ["focus"],
        dataLayers: [{ key: "telemetry" }],
        properties: [{ key: "speed", type: "number" as const }],
      },
    };
    const resource = {
      id: "unity-1",
      projectId: "project-1",
      name: "Factory",
      activeVersionId: "v2",
      versions: [version],
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    };
    expect(
      reconcileUnityVersionWidget(
        {
          title: "Unity",
          key: "unity",
          type: "unity",
          unit: "",
          unityDataBindings: [{ layerKey: "removed", dataKey: "legacy" }],
          unityPropertyValues: { speed: 2, removed: true },
          unityDefaultAction: { action: "removed" },
        },
        resource,
        version,
      ),
    ).toMatchObject({
      unityScene: "Factory",
      unityDataBindings: [{ layerKey: "telemetry", dataKey: "telemetry" }],
      unityPropertyValues: { speed: 2 },
    });
  });
});
