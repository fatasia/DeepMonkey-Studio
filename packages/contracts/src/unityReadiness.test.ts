import { describe, expect, it } from "vitest";
import type { ApplicationDocument, DashboardDataWidgetNode, UnityResourceRecord } from "./index.js";
import { assessUnityApplicationReadiness } from "./unityReadiness.js";

const widget: DashboardDataWidgetNode = {
  id: "unity-widget",
  name: "Unity",
  kind: "data-widget",
  zIndex: 0,
  frame: { x: 0, y: 0, width: 800, height: 450 },
  widget: {
    title: "Factory",
    key: "factory",
    type: "unity",
    unit: "",
    unityResourceId: "resource",
    unityResourceVersionId: "version",
    unityScene: "Factory",
    unityDataBindings: [{ layerKey: "telemetry", dataKey: "data.rows" }],
  },
};
const application = { pages: [{ id: "page", name: "Dashboard", width: 1920, height: 1080, viewportFit: "contain", nodes: [widget] }] } as ApplicationDocument;

function resource(patch: Partial<UnityResourceRecord["versions"][number]["manifest"]> = {}): UnityResourceRecord {
  return {
    id: "resource",
    projectId: "project",
    name: "Factory",
    activeVersionId: "version",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    versions: [
      {
        id: "version",
        resourceId: "resource",
        version: 1,
        sourceFileName: "factory.zip",
        contentHash: "hash",
        size: 100,
        fileCount: 20,
        playerUrl: "/assets/factory/index.html",
        manifestUrl: "/assets/factory/bim-studio.manifest.json",
        diagnostics: [],
        createdAt: "2026-01-01",
        manifest: {
          schemaVersion: 1,
          bridgeVersion: 1,
          playerUrl: "index.html",
          unityVersion: "2022.3.62f1",
          scenes: ["Factory"],
          dataLayers: [{ key: "telemetry" }],
          runtimeCapabilities: ["ack", "heartbeat"],
          ...patch,
        },
      },
    ],
  };
}

describe("Unity publication readiness", () => {
  it("accepts a managed, supported and fully bound Unity build", () => {
    expect(assessUnityApplicationReadiness(application, [resource()])).toEqual([]);
  });

  it("blocks missing resources and unsupported editor versions", () => {
    expect(assessUnityApplicationReadiness(application, []).map((item) => item.code)).toContain("missing-resource");
    expect(assessUnityApplicationReadiness(application, [resource({ unityVersion: "2021.3.10f1" })])).toContainEqual(
      expect.objectContaining({ code: "unsupported-version", severity: "blocker" }),
    );
  });

  it("warns about manifest layers that are not bound", () => {
    const unbound = structuredClone(application);
    (unbound.pages[0]!.nodes[0] as DashboardDataWidgetNode).widget.unityDataBindings = [];
    expect(assessUnityApplicationReadiness(unbound, [resource()])).toContainEqual(expect.objectContaining({ code: "unbound-layer", severity: "warning" }));
  });

  it("warns when an older bridge has no acknowledgement or heartbeat contract", () => {
    expect(assessUnityApplicationReadiness(application, [resource({ runtimeCapabilities: [] })])).toContainEqual(
      expect.objectContaining({ code: "missing-health-contract", severity: "warning" }),
    );
  });
});
