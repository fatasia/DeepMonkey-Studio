import { describe, expect, it } from "vitest";
import dashboardFixture from "../../../test-fixtures/scene-v1-dashboard.json";
import interactionFixture from "../../../test-fixtures/scene-v1-interaction.json";
import pure3dFixture from "../../../test-fixtures/scene-v1-pure-3d.json";
import behaviorApplicationFixture from "../fixtures/application-v2-worker-behavior.json";
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
  ["page", () => altered(pureApplication, (value) => { value.pages[0]!.width = 319; })],
  ["page viewport fit", () => altered(pureApplication, (value) => { value.pages[0]!.viewportFit = "tile" as never; })],
  ["scene viewport widget", () => altered(pureApplication, (value) => {
    const node = value.pages[0]!.nodes[0]!;
    node.kind = "unknown" as never;
  })],
  ["native data widget", () => altered(pureApplication, (value) => {
    value.pages[0]!.nodes.push({
      id: "widget:invalid",
      kind: "data-widget",
      frame: { x: 0, y: 0, width: 320, height: 180 },
      zIndex: 1,
      widget: { title: "无效", key: "value", type: "dial" as never, unit: "" }
    });
  })],
  ["native data widget animation autoplay", () => altered(pureApplication, (value) => {
    value.pages[0]!.nodes.push({
      id: "widget:invalid-animation",
      kind: "data-widget",
      frame: { x: 0, y: 0, width: 320, height: 180 },
      zIndex: 1,
      widget: {
        title: "无效动画",
        key: "value",
        type: "value",
        unit: "",
        animationAutoplay: "yes" as never,
      },
    });
  })],
  ["duplicate dashboard component name", () => altered(pureApplication, (value) => {
    const source = value.pages[0]!.nodes[0]!;
    source.name = "Main View";
    value.pages[0]!.nodes.push({ ...structuredClone(source), id: "widget:duplicate-name", name: " main view " });
  })],
  ["native data widget direct binding", () => altered(pureApplication, (value) => {
    value.pages[0]!.nodes.push({
      id: "widget:invalid-direct",
      kind: "data-widget",
      frame: { x: 0, y: 0, width: 320, height: 180 },
      zIndex: 1,
      widget: {
        title: "无效绑定", key: "value", type: "value", unit: "",
        directBinding: { version: 1, gateway: "server", transport: "http", endpoint: "https://example.com" } as never
      }
    });
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
  ["scene selection set", () => altered(pureApplication, (value) => {
    value.scenes[0]!.selectionSets = [{ id: "selection-1", name: "产线", objectIds: [1 as never] }];
  })],
  ["scene asset binding confidence", () => altered(pureApplication, (value) => {
    value.scenes[0]!.assetBindings = [{
      id: "binding-1", sceneObjectId: "model-1/pump", objectName: "循环泵", modelId: "model-1",
      layerId: "pump", deviceId: "P-001", confidence: 1.2, confirmedAt: "2026-08-30T08:00:00.000Z",
    }];
  })],
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
  ["interaction", () => altered(interactionApplication, (value) => { value.interactions[0]!.trigger = "tripleClick" as never; })],
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
  ["script enabled", () => altered(interactionApplication, (value) => { value.scripts[0]!.enabled = "yes" as never; })],
  ["script enabled missing", () => altered(interactionApplication, (value) => { Reflect.deleteProperty(value.scripts[0]!, "enabled"); })],
  ["script lifecycle", () => altered(interactionApplication, (value) => { value.scripts[0]!.lifecycle = ["beforeRender" as never]; })],
  ["script lifecycle missing", () => altered(interactionApplication, (value) => { Reflect.deleteProperty(value.scripts[0]!, "lifecycle"); })],
  ["script permissions", () => altered(interactionApplication, (value) => { value.scripts[0]!.permissions = ["filesystem.write" as never]; })],
  ["script permissions missing", () => altered(interactionApplication, (value) => { Reflect.deleteProperty(value.scripts[0]!, "permissions"); })],
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
  ["script dependency integrity", () => altered(interactionApplication, (value) => {
    value.scriptDependencies = [scriptDependency({ integrity: "sha256-invalid" })];
  })],
  ["script dependency duplicate specifier", () => altered(interactionApplication, (value) => {
    value.scriptDependencies = [scriptDependency(), scriptDependency({ id: "dependency-2" })];
  })],
  ["asset", () => altered(pureApplication, (value) => {
    value.assets = [{ id: "asset-1", kind: "model", projectId: "project-golden", sourceFormat: "xyz" as never }];
  })],
  ["asset optional property", () => altered(pureApplication, (value) => {
    value.assets = [{ id: "asset-1", kind: "model", projectId: "project-golden", sourceName: undefined as never }];
  })],
  ["timeline", () => altered(pureApplication, (value) => {
    value.timelines = [{ id: "timeline-1", name: "施工进度", duration: "long" as never, trackIds: [] }];
  })],
  ["publication profile", () => altered(pureApplication, (value) => {
    value.publicationProfiles[0]!.renderer = "canvas" as never;
  })],
  ["spatial navigation duplicate node", () => altered(pureApplication, (value) => {
    value.spatialNavigation = {
      rootNodeIds: ["campus"], cacheLimit: 2,
      nodes: [
        { id: "campus", name: "园区", kind: "campus", loadPolicy: "replace" },
        { id: "campus", name: "重复园区", kind: "campus", loadPolicy: "replace" }
      ]
    };
  })],
  ["spatial navigation missing parent", () => altered(pureApplication, (value) => {
    value.spatialNavigation = {
      rootNodeIds: ["campus"], cacheLimit: 2,
      nodes: [
        { id: "campus", name: "园区", kind: "campus", loadPolicy: "replace" },
        { id: "line", name: "产线", kind: "line", parentId: "missing", loadPolicy: "additive" }
      ]
    };
  })]
];

describe("assertApplicationDocument", () => {
  it.each([pureApplication, dashboardApplication, interactionApplication])("accepts a migrated ApplicationDocument v2", (application) => {
    expect(() => assertApplicationDocument(application)).not.toThrow();
  });

  it("accepts explicit dashboard animation playback policy", () => {
    const application = structuredClone(pureApplication);
    application.pages[0]!.nodes.push({
      id: "widget:animation-policy",
      kind: "data-widget",
      frame: { x: 0, y: 0, width: 320, height: 180 },
      zIndex: 1,
      widget: {
        title: "运行状态",
        key: "status",
        type: "value",
        unit: "",
        animation: "fade",
        animationAutoplay: true,
        animationLoop: false,
        animationDuration: 0.6,
        animationDelay: 0.1,
      },
    });

    expect(() => assertApplicationDocument(application)).not.toThrow();
  });

  it("accepts a complete sandboxed worker behavior module", () => {
    const application = structuredClone(behaviorApplicationFixture) as unknown as ApplicationDocument;

    expect(() => assertApplicationDocument(application)).not.toThrow();
    expect(application.scripts[0]).toMatchObject({
      enabled: true,
      runtime: "worker-sandbox",
      lifecycle: ["onStart", "onUpdate", "onFixedUpdate", "onData", "onEvent", "onStop", "onDispose"],
      permissions: ["scene.read", "scene.write", "data.read"]
    });
  });

  it("accepts a locally cached and hash-locked script dependency", () => {
    const application = structuredClone(interactionApplication);
    application.scriptDependencies = [scriptDependency()];
    expect(() => assertApplicationDocument(application)).not.toThrow();
  });

  it("accepts an object-attached behavior target and rejects a missing target id", () => {
    const application = structuredClone(behaviorApplicationFixture) as unknown as ApplicationDocument;
    application.scripts[0]!.target = { kind: "object", id: "pump-01" };
    expect(() => assertApplicationDocument(application)).not.toThrow();
    application.scripts[0]!.target = { kind: "object" } as never;
    expect(() => assertApplicationDocument(application)).toThrow(/target.*id/i);
  });

  it("accepts a custom ultra-wide dashboard resolution", () => {
    const application = structuredClone(pureApplication);
    Object.assign(application.pages[0]!, { width: 3840, height: 1080, viewportFit: "contain" as const });

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
    application.assets = [
      { id: "asset-1", kind: "model", projectId: "project-golden", sourceName: "plant.ifc", sourceFormat: "ifc", contentHash: "sha256:example" },
      { id: "asset-2", kind: "model", projectId: "project-golden", sourceName: "surface.iges", sourceFormat: "iges", contentHash: "sha256:iges" },
      { id: "asset-3", kind: "model", projectId: "project-golden", sourceName: "fixture.obj", sourceFormat: "obj", contentHash: "sha256:obj" },
    ];
    application.timelines = [{ id: "timeline-1", name: "施工进度", duration: 120, trackIds: ["track-1"] }];

    expect(() => assertApplicationDocument(application)).not.toThrow();
  });

  it("accepts a first-class native data widget", () => {
    const application = structuredClone(pureApplication);
    application.pages[0]!.nodes.push({
      id: "widget:temperature",
      kind: "data-widget",
      frame: { x: 40, y: 40, width: 360, height: 200 },
      zIndex: 2,
      widget: { title: "温度趋势", key: "device.temperature", type: "line", unit: "℃", color: "#e1ad4e" }
    });

    expect(() => assertApplicationDocument(application)).not.toThrow();
  });

  it("validates nested dashboard analysis and multi-measure report settings", () => {
    const application = structuredClone(pureApplication);
    application.pages[0]!.nodes.push({
      id: "widget:report",
      kind: "data-widget",
      frame: { x: 40, y: 40, width: 640, height: 320 },
      zIndex: 2,
      widget: {
        title: "区域经营交叉表", key: "sales", type: "table", unit: "元",
        analysis: { dimensionField: "region", measureField: "sales", aggregation: "sum" },
        report: { mode: "crosstab", rowField: "region", columnField: "month", valueField: "sales", valueFields: ["sales", "cost"], aggregation: "sum", showSubtotal: true, showGrandTotal: true }
      }
    });

    expect(() => assertApplicationDocument(application)).not.toThrow();
    const invalid = structuredClone(application);
    const node = invalid.pages[0]!.nodes.at(-1)!;
    if (node.kind !== "data-widget") throw new Error("expected data widget");
    node.widget.report!.valueFields = ["sales", 2 as never];
    expect(() => assertApplicationDocument(invalid)).toThrow(/valueFields/);
  });

  it.each(["digital-flip", "liquid-fill", "scroll-table", "combo"] as const)("accepts the native %s dashboard widget", (type) => {
    const application = structuredClone(pureApplication);
    application.pages[0]!.nodes.push({
      id: `widget:${type}`,
      kind: "data-widget",
      frame: { x: 40, y: 40, width: 360, height: 200 },
      zIndex: 2,
      widget: { title: type, key: "device.value", type, unit: "" }
    });

    expect(() => assertApplicationDocument(application)).not.toThrow();
  });

  it("accepts renderer-independent scene selection sets", () => {
    const application = structuredClone(pureApplication);
    application.scenes[0]!.selectionSets = [{ id: "selection-1", name: "一号产线", objectIds: ["robot-1", "conveyor-2"], kind: "group" }];

    expect(() => assertApplicationDocument(application)).not.toThrow();
  });

  it("accepts persisted human-confirmed scene asset bindings", () => {
    const application = structuredClone(pureApplication);
    application.scenes[0]!.assetBindings = [{
      id: "binding-1", sceneObjectId: "model-1/pump", objectName: "循环泵", modelId: "model-1",
      layerId: "pump", deviceId: "P-001", confidence: 0.94, confirmedAt: "2026-08-30T08:00:00.000Z",
    }];

    expect(() => assertApplicationDocument(application)).not.toThrow();
  });

  it("accepts one spatial hierarchy shared by 2D pages and 3D scenes", () => {
    const application = structuredClone(pureApplication);
    application.spatialNavigation = {
      rootNodeIds: ["campus"],
      cacheLimit: 3,
      nodes: [
        {
          id: "campus", name: "智造园区", kind: "campus",
          sceneId: application.scenes[0]!.id,
          dashboardPageId: application.pages[0]!.id,
          loadPolicy: "replace"
        },
        {
          id: "robot", name: "机器人 A", kind: "equipment", parentId: "campus",
          sceneId: application.scenes[0]!.id,
          target: { modelId: "robot-a" },
          loadPolicy: "focus"
        }
      ]
    };

    expect(() => assertApplicationDocument(application)).not.toThrow();
  });

  it("accepts a dashboard widget bound to a visual data pipeline", () => {
    const application = structuredClone(pureApplication);
    application.pages[0]!.nodes.push({
      id: "widget:throughput",
      kind: "data-widget",
      frame: { x: 40, y: 40, width: 360, height: 200 },
      zIndex: 2,
      widget: {
        title: "产线节拍",
        key: "pipeline-cycle.cycle_time",
        type: "value",
        unit: "s",
        pipelineId: "pipeline-cycle",
        field: "cycle_time"
      }
    });

    expect(() => assertApplicationDocument(application)).not.toThrow();
  });

  it("accepts one shared data product binding on a 3D scene object", () => {
    const application = structuredClone(pureApplication);
    application.scenes[0]!.dataBindings = [{
      id: "binding-robot",
      name: "机器人在线状态",
      enabled: true,
      pipelineId: "pipeline-robots",
      field: "online",
      target: { modelId: "robot-1" },
      action: "visibility",
      refreshSeconds: 5
    }];

    expect(() => assertApplicationDocument(application)).not.toThrow();
  });

  it("accepts the complete PBR texture set and validates numeric texture controls", () => {
    const application = structuredClone(pureApplication);
    application.scenes[0]!.models.push({
      modelId: "pump-1",
      name: "循环水泵",
      visible: true,
      opacity: 1,
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      material: {
        baseColorMapUrl: "/assets/pump/base.webp",
        normalMapUrl: "/assets/pump/normal.webp",
        emissiveMapUrl: "/assets/pump/emissive.webp",
        ambientOcclusionMapUrl: "/assets/pump/ao.webp",
        roughnessMapUrl: "/assets/pump/roughness.webp",
        metalnessMapUrl: "/assets/pump/metalness.webp",
        textureRepeat: 2,
        textureRotation: 0.5,
        normalScale: 1.4
      },
      rig: {
        bones: [{ bonePath: "root/Armature/UpperArm", rotation: { x: 0.1, y: 0.2, z: 0 } }],
        ik: [{ id: "ik-hand", effectorBonePath: "root/Armature/Hand", target: { x: 1.2, y: 0.8, z: -0.3 }, chainLength: 2, iterations: 12, enabled: true }]
      }
    });
    application.scenes[0]!.animation = {
      duration: 8,
      loop: false,
      frameRate: 30,
      snapToFrames: true,
      modelInterpolation: "linear",
      camera: [],
      models: [{
        id: "frame-1",
        time: 2,
        modelId: "pump-1",
        transform: structuredClone(application.scenes[0]!.models[0]!.transform),
        animation: { clipId: "PumpCycle", time: 1.25 }
      }]
    };
    expect(() => assertApplicationDocument(application)).not.toThrow();

    application.scenes[0]!.models[0]!.material!.normalScale = "strong" as never;
    expect(() => assertApplicationDocument(application)).toThrow("normalScale");
  });

  it("accepts one reusable direct HTTP binding on 2D and 3D components", () => {
    const application = structuredClone(pureApplication);
    const directBinding = {
      version: 1 as const,
      gateway: "server" as const,
      transport: "http" as const,
      endpoint: "https://telemetry.example.com/current",
      selection: { jsonPath: "$.data", field: "temperature" },
      http: { method: "GET" as const, params: { device: "{{deviceId}}" }, refresh: { intervalMs: 5_000 } }
    };
    application.pages[0]!.nodes.push({
      id: "widget:direct-temperature",
      kind: "data-widget",
      frame: { x: 40, y: 40, width: 360, height: 200 },
      zIndex: 2,
      widget: { title: "设备温度", key: "temperature", type: "value", unit: "℃", directBinding }
    });
    application.scenes[0]!.dataBindings = [{
      id: "binding-direct-temperature",
      name: "设备温度显色",
      enabled: true,
      directBinding,
      field: "temperature",
      target: { modelId: "robot-1" },
      action: "color",
      refreshSeconds: 5
    }];

    expect(() => assertApplicationDocument(application)).not.toThrow();
  });

  it("accepts an explicit undefined SceneInteractionActionState target", () => {
    const application = structuredClone(interactionApplication);
    application.interactions[0]!.actions[0]!.target = undefined;
    application.interactions[0]!.legacyScript!.script.actions![0]!.target = undefined;

    expect(() => assertApplicationDocument(application)).not.toThrow();
  });

  it("accepts a bounded visual transition on interaction actions", () => {
    const application = structuredClone(interactionApplication);
    application.interactions[0]!.actions[0]!.transition = {
      kind: "fade",
      durationMs: 320,
      easing: "ease-in-out",
    };
    expect(() => assertApplicationDocument(application)).not.toThrow();
  });

  it("accepts route arrival triggers and prefab runtime actions", () => {
    const application = structuredClone(interactionApplication);
    application.interactions[0]!.trigger = "routePointReached";
    application.interactions[0]!.actions[0] = {
      id: "action-dispatch-agv",
      type: "prefabAction",
      enabled: true,
      prefabAction: "replay",
      target: { kind: "object", modelId: "robot-1" },
    };
    expect(() => assertApplicationDocument(application)).not.toThrow();
  });

  it("accepts physics collision start/end triggers", () => {
    const application = structuredClone(interactionApplication);
    application.interactions[0]!.trigger = "collisionStart";
    expect(() => assertApplicationDocument(application)).not.toThrow();
    application.interactions[0]!.trigger = "collisionEnd";
    expect(() => assertApplicationDocument(application)).not.toThrow();
  });

  it("rejects an unknown interaction transition", () => {
    const application = structuredClone(interactionApplication);
    application.interactions[0]!.actions[0]!.transition = {
      kind: "explode",
      durationMs: 320,
      easing: "ease-out",
    } as never;
    expect(() => assertApplicationDocument(application)).toThrow("transition.kind");
  });

  it.each(["", ".", "..", "bad/id", "bad\\id", "bad?query", "bad#fragment", "a".repeat(129)])
    ("rejects path-unsafe application ID %j", (id) => {
      const application = altered(pureApplication, (value) => { value.metadata.id = id; });
      expect(() => assertApplicationDocument(application)).toThrow("应用.metadata.id");
    });

  it.each(["", ".", "..", "bad/id", "bad\\id", "bad?query", "bad#fragment", "a".repeat(129)])
    ("rejects path-unsafe project ID %j", (projectId) => {
      const application = altered(pureApplication, (value) => { value.metadata.projectId = projectId; });
      expect(() => assertApplicationDocument(application)).toThrow("应用.metadata.projectId");
    });

  it.each([
    ["sparse", (array: unknown[]) => { array.length = 2; array[1] = pureApplication.pages[0]; }],
    ["custom string property", (array: unknown[]) => { array.push(pureApplication.pages[0]); Reflect.set(array, "extra", true); }],
    ["symbol property", (array: unknown[]) => { array.push(pureApplication.pages[0]); Reflect.set(array, Symbol("extra"), true); }]
  ] as const)("rejects a %s on structural arrays", (_name, corrupt) => {
    const application = structuredClone(pureApplication);
    const pages: unknown[] = [];
    corrupt(pages);
    Reflect.set(application, "pages", pages);
    expect(() => assertApplicationDocument(application)).toThrow("应用.pages");
  });

  it("rejects custom properties on nested structural arrays", () => {
    const application = structuredClone(pureApplication);
    Reflect.set(application.pages[0]!.nodes, "extra", true);
    expect(() => assertApplicationDocument(application)).toThrow("应用.pages[0].nodes");
  });

  it.each(malformedCases)("rejects malformed %s", (_name, valueFactory) => {
    expect(() => assertApplicationDocument(valueFactory())).toThrow();
  });
});

function scriptDependency(overrides: Partial<NonNullable<ApplicationDocument["scriptDependencies"]>[number]> = {}) {
  return {
    id: "dependency-1",
    specifier: "@plant/math",
    source: "npm" as const,
    requested: "@plant/math@1.2.3",
    resolvedVersion: "1.2.3",
    fileName: "plant-math-1.2.3.mjs",
    assetUrl: "/api/projects/project-1/script-dependencies/dependency-1/content",
    integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
    size: 24,
    installedAt: "2026-09-04T00:00:00.000Z",
    ...overrides,
  };
}
