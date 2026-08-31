import type { ApplicationDocument, ProjectRecord } from "@bim-studio/contracts";
import { describe, expect, it, vi } from "vitest";
import { executeUnityScriptCommand } from "./unityScriptCommandHost";

describe("executeUnityScriptCommand", () => {
  it("applies manifest-whitelisted properties and scenes", () => {
    const updateWidget = vi.fn();
    const options = { application: application(), project: project(), updateWidget, dispatchAction: vi.fn() };
    executeUnityScriptCommand({ id: "p", type: "unity.properties.set", componentId: "unity-1", values: { lightIntensity: 3 } }, options);
    executeUnityScriptCommand({ id: "s", type: "unity.scene.switch", componentId: "unity-1", scene: "Factory" }, options);
    expect(updateWidget).toHaveBeenNthCalledWith(1, "unity-1", { unityPropertyValues: { lightIntensity: 3 } });
    expect(updateWidget).toHaveBeenNthCalledWith(2, "unity-1", { unityScene: "Factory" });
  });

  it("dispatches only declared actions and objects", () => {
    const dispatchAction = vi.fn();
    const options = { application: application(), project: project(), updateWidget: vi.fn(), dispatchAction };
    executeUnityScriptCommand({ id: "a", type: "unity.action.invoke", componentId: "unity-1", action: "focus", objectId: "robot", value: 2 }, options);
    expect(dispatchAction).toHaveBeenCalledWith({ widgetId: "unity-1", action: "focus", objectId: "robot", value: 2 });
    expect(() => executeUnityScriptCommand({ id: "x", type: "unity.action.invoke", componentId: "unity-1", action: "eval" }, options)).toThrow("未在当前构建清单");
  });

  it("rejects a non-Unity component", () => {
    const source = application();
    source.pages[0]!.nodes[0] = { ...source.pages[0]!.nodes[0]!, kind: "data-widget", widget: { title: "KPI", key: "", unit: "", type: "value" } };
    expect(() =>
      executeUnityScriptCommand(
        { id: "x", type: "unity.scene.switch", componentId: "unity-1", scene: "Factory" },
        { application: source, project: project(), updateWidget: vi.fn(), dispatchAction: vi.fn() },
      ),
    ).toThrow("不是 Unity 组件");
  });
});

function application(): ApplicationDocument {
  return {
    metadata: { id: "app", projectId: "project", name: "test", version: 1, createdAt: "now", updatedAt: "now" },
    pages: [
      {
        id: "page",
        name: "page",
        width: 1920,
        height: 1080,
        nodes: [
          {
            id: "unity-1",
            name: "Unity",
            kind: "data-widget",
            frame: { x: 0, y: 0, width: 640, height: 360 },
            zIndex: 1,
            widget: { title: "Unity", key: "", unit: "", type: "unity", unityResourceId: "resource", unityResourceVersionId: "version" },
          },
        ],
      },
    ],
    scenes: [],
    interactions: [],
    data: { variables: [], sources: [] },
    scripts: [],
    topologies: [],
    publicationProfiles: [],
  } as unknown as ApplicationDocument;
}

function project(): ProjectRecord {
  const manifest = {
    schemaVersion: 1,
    bridgeVersion: 1,
    playerUrl: "https://example.test",
    scenes: ["Factory"],
    actions: ["focus"],
    objects: [{ id: "robot" }],
    properties: [{ key: "lightIntensity", type: "number" }],
  } as const;
  return {
    id: "project",
    name: "project",
    models: [],
    createdAt: "now",
    updatedAt: "now",
    unityResources: [
      {
        id: "resource",
        projectId: "project",
        name: "runtime",
        activeVersionId: "version",
        createdAt: "now",
        updatedAt: "now",
        versions: [
          {
            id: "version",
            resourceId: "resource",
            version: 1,
            sourceFileName: "build.zip",
            contentHash: "hash",
            size: 1,
            fileCount: 1,
            playerUrl: manifest.playerUrl,
            manifestUrl: "manifest.json",
            manifest,
            diagnostics: [],
            createdAt: "now",
          },
        ],
      },
    ],
  } as unknown as ProjectRecord;
}
