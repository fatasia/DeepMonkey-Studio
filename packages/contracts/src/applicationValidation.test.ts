import { describe, expect, it } from "vitest";
import dashboardFixture from "./__fixtures__/scene-v1-dashboard.json";
import interactionFixture from "./__fixtures__/scene-v1-interaction.json";
import pure3dFixture from "./__fixtures__/scene-v1-pure-3d.json";
import { assertApplicationDocument, type ApplicationDocument } from "./application.js";
import { migrateSceneSnapshotV1 } from "./applicationMigration.js";
import type { SceneSnapshot } from "./index.js";

type MalformedCase = readonly [string, () => unknown];

const pureApplication = migrateSceneSnapshotV1(pure3dFixture as SceneSnapshot);
const dashboardApplication = migrateSceneSnapshotV1(dashboardFixture as SceneSnapshot);
const interactionApplication = migrateSceneSnapshotV1(interactionFixture as SceneSnapshot);

function altered(source: ApplicationDocument, mutate: (value: ApplicationDocument) => void): unknown {
  const value = structuredClone(source);
  mutate(value);
  return value;
}

const malformedCases: MalformedCase[] = [
  ["metadata", () => altered(pureApplication, (value) => Reflect.deleteProperty(value.metadata, "name"))],
  ["metadata source", () => altered(pureApplication, (value) => { value.metadata.source!.kind = "import" as never; })],
  ["page", () => altered(pureApplication, (value) => { value.pages[0]!.width = 1080 as never; })],
  ["scene viewport widget", () => altered(pureApplication, (value) => {
    const node = value.pages[0]!.nodes[0]!;
    node.kind = "unknown" as never;
  })],
  ["legacy dashboard widget", () => altered(dashboardApplication, (value) => {
    const node = value.pages[0]!.nodes[1]!;
    if (node.kind === "legacy-dashboard-panel") node.state.side = "center" as never;
  })],
  ["topology", () => altered(pureApplication, (value) => {
    value.topologies = [{ id: "topology-1", name: 7 as never, nodes: [], edges: [] }];
  })],
  ["topology node", () => altered(pureApplication, (value) => {
    value.topologies = [{ id: "topology-1", name: "拓扑", nodes: [{ id: "node-1", kind: "pump", x: 0, y: 0, properties: { nested: undefined as never } }], edges: [] }];
  })],
  ["topology non-enumerable JSON property", () => altered(pureApplication, (value) => {
    const properties: Record<string, unknown> = {};
    Object.defineProperty(properties, "hidden", { value: undefined, enumerable: false });
    value.topologies = [{ id: "topology-1", name: "拓扑", nodes: [{ id: "node-1", kind: "pump", x: 0, y: 0, properties: properties as never }], edges: [] }];
  })],
  ["topology edge", () => altered(pureApplication, (value) => {
    value.topologies = [{ id: "topology-1", name: "拓扑", nodes: [], edges: [{ id: "edge-1", sourceNodeId: "a", targetNodeId: 3 as never, properties: {} }] }];
  })],
  ["scene", () => altered(pureApplication, (value) => { value.scenes[0]!.camera.mode = "fly" as never; })],
  ["geo root", () => altered(pureApplication, (value) => { value.geo = true as never; })],
  ["geo layer", () => altered(pureApplication, (value) => {
    value.geo.layers = [{ id: "layer-1", providerId: "provider-1", visible: "yes" as never }];
  })],
  ["data root", () => altered(pureApplication, (value) => { value.data = false as never; })],
  ["data transform", () => altered(pureApplication, (value) => {
    value.data.transforms = [{ id: "transform-1", expression: false as never }];
  })],
  ["data recursive JSON variable", () => altered(pureApplication, (value) => {
    value.data.variables = [{ id: "variable-1", value: { nested: [1, { invalid: undefined as never }] } }];
  })],
  ["data non-JSON object variable", () => altered(pureApplication, (value) => {
    value.data.variables = [{ id: "variable-1", value: new Date("2026-08-20T00:00:00.000Z") as never }];
  })],
  ["data non-enumerable JSON property", () => altered(pureApplication, (value) => {
    const payload: Record<string, unknown> = {};
    Object.defineProperty(payload, "hidden", { value: () => "invalid", enumerable: false });
    value.data.variables = [{ id: "variable-1", value: payload as never }];
  })],
  ["data JSON symbol property", () => altered(pureApplication, (value) => {
    const payload = { valid: true } as Record<PropertyKey, unknown>;
    Object.defineProperty(payload, Symbol("invalid"), { value: undefined, enumerable: true });
    value.data.variables = [{ id: "variable-1", value: payload as never }];
  })],
  ["data JSON array symbol property", () => altered(pureApplication, (value) => {
    const payload = [true] as unknown[] & Record<PropertyKey, unknown>;
    Object.defineProperty(payload, Symbol("invalid"), { value: () => "invalid", enumerable: true });
    value.data.variables = [{ id: "variable-1", value: payload as never }];
  })],
  ["interaction", () => altered(interactionApplication, (value) => { value.interactions[0]!.trigger = "doubleClick" as never; })],
  ["interaction object reference", () => altered(interactionApplication, (value) => {
    value.interactions[0]!.source = { kind: "object", sceneId: "scene-interaction", modelId: 1 } as never;
  })],
  ["interaction action", () => altered(interactionApplication, (value) => {
    value.interactions[0]!.actions[0]!.type = "execute" as never;
  })],
  ["interaction legacy script boundary", () => altered(interactionApplication, (value) => {
    value.interactions[0]!.legacyScript!.runtime = "worker-sandbox" as never;
  })],
  ["interaction legacy script", () => altered(interactionApplication, (value) => {
    value.interactions[0]!.legacyScript!.script.code = 42 as never;
  })],
  ["script", () => altered(interactionApplication, (value) => { value.scripts[0]!.capabilities = [false as never]; })],
  ["script api version missing", () => altered(interactionApplication, (value) => {
    Reflect.deleteProperty(value.scripts[0]!, "apiVersion");
  })],
  ["script api version", () => altered(interactionApplication, (value) => {
    Reflect.set(value.scripts[0]!, "apiVersion", "1.1");
  })],
  ["script entrypoint missing", () => altered(interactionApplication, (value) => {
    Reflect.deleteProperty(value.scripts[0]!, "entrypoint");
  })],
  ["script entrypoint", () => altered(interactionApplication, (value) => {
    Reflect.set(value.scripts[0]!, "entrypoint", "module");
  })],
  ["asset", () => altered(pureApplication, (value) => {
    value.assets = [{ id: "asset-1", kind: "model", projectId: "project-golden", sourceFormat: "obj" as never }];
  })],
  ["asset optional property", () => altered(pureApplication, (value) => {
    value.assets = [{ id: "asset-1", kind: "model", projectId: "project-golden", sourceName: undefined as never }];
  })],
  ["timeline", () => altered(pureApplication, (value) => {
    value.timelines = [{ id: "timeline-1", name: "施工进度", duration: "long" as never, trackIds: [] }];
  })],
  ["publication profile", () => altered(pureApplication, (value) => {
    value.publicationProfiles[0]!.renderer = "canvas" as never;
  })]
];

describe("assertApplicationDocument", () => {
  it.each([pureApplication, dashboardApplication, interactionApplication])("accepts a migrated ApplicationDocument v2", (application) => {
    expect(() => assertApplicationDocument(application)).not.toThrow();
  });

  it("accepts valid non-empty topology, geo, data, asset, and timeline families", () => {
    const application = structuredClone(pureApplication);
    application.topologies = [{
      id: "topology-1",
      name: "设备拓扑",
      nodes: [{ id: "node-1", kind: "pump", x: 10, y: 20, properties: { telemetry: [1, true, null, { label: "P-1" }] } }],
      edges: [{ id: "edge-1", sourceNodeId: "node-1", targetNodeId: "node-2", properties: { active: true } }]
    }];
    application.geo = { providerIds: ["provider-1"], layers: [{ id: "layer-1", providerId: "provider-1", visible: true }] };
    application.data = {
      connectionIds: ["connection-1"],
      datasetIds: ["dataset-1"],
      transforms: [{ id: "transform-1", expression: "value * 2" }],
      variables: [{ id: "variable-1", value: { thresholds: [10, 20] } }]
    };
    application.assets = [{ id: "asset-1", kind: "model", projectId: "project-golden", sourceName: "plant.ifc", sourceFormat: "ifc", contentHash: "sha256:example" }];
    application.timelines = [{ id: "timeline-1", name: "施工进度", duration: 120, trackIds: ["track-1"] }];

    expect(() => assertApplicationDocument(application)).not.toThrow();
  });

  it("accepts an explicit undefined SceneInteractionActionState target", () => {
    const application = structuredClone(interactionApplication);
    application.interactions[0]!.actions[0]!.target = undefined;
    application.interactions[0]!.legacyScript!.script.actions![0]!.target = undefined;

    expect(() => assertApplicationDocument(application)).not.toThrow();
  });

  it.each(malformedCases)("rejects malformed %s", (_name, valueFactory) => {
    expect(() => assertApplicationDocument(valueFactory())).toThrow();
  });
});
