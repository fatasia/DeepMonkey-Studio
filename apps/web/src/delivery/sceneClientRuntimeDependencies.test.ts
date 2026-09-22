import { describe, expect, it } from "vitest";
import { migrateSceneSnapshotV1, type ProjectRecord, type SceneSnapshot } from "@bim-studio/contracts";
import { selectSceneClientRuntimeDependencies as select } from "./sceneClientRuntimeDependencies";

function fixture() {
  const scene = { schemaVersion: 1, id: "scene", projectId: "project", name: "Scene", models: [], primitives: [],
    measurements: [], camera: { position: [1, 1, 1], target: [0, 0, 0] }, createdAt: "now", updatedAt: "now" } as unknown as SceneSnapshot;
  const project = { id: "project", models: [], dataConnections: ["unused", "first", "second"].map(id => ({
    id, projectId: "project", name: id, type: "simulation", enabled: true, config: { url: "sim://telemetry" } })),
  datasets: [{ id: "data", projectId: "project", connectionId: "first", fields: [] }],
  dataPipelines: [{ id: "pipe", projectId: "project", nodes: [{ id: "source", type: "source", datasetId: "data" },
    { id: "output", type: "output" }], edges: [{ id: "edge", sourceNodeId: "source", targetNodeId: "output" }] }] } as unknown as ProjectRecord;
  return { scene, project, app: migrateSceneSnapshotV1(scene) };
}

describe("selectSceneClientRuntimeDependencies", () => {
  it("keeps empty roots empty despite project resources and ID-like text", () => {
    const { project, scene, app } = fixture();
    scene.name = "datasetId:data pipelineId:pipe";
    app.data.variables = [{ id: "value", value: { datasetId: "data" } }];
    expect(select(project, [scene], [app])).toEqual({ connections: [], datasets: [], pipelines: [] });
  });

  it("closes scene and widget pipeline dependencies, deduplicates and preserves project order", () => {
    const { project, scene, app } = fixture();
    scene.dataBindings = [{ id: "binding", enabled: false, pipelineId: "pipe" }] as NonNullable<SceneSnapshot["dataBindings"]>;
    app.data.connectionIds = ["second", "first"];
    app.data.datasetIds = ["data"];
    app.pages[0]!.nodes.push({ id: "chart", kind: "data-widget", widget: { datasetId: "data", pipelineId: "pipe" } } as never);
    const result = select(project, [scene], [app]);
    expect(result.connections.map(item => item.id)).toEqual(["first", "second"]);
    expect(result.datasets.map(item => item.id)).toEqual(["data"]);
    expect(result.pipelines.map(item => item.id)).toEqual(["pipe"]);
    result.connections[0]!.config.url = "changed";
    expect(project.dataConnections![1]!.config.url).toBe("sim://telemetry");
  });

  it("includes legacy dashboard and embedded application scene bindings", () => {
    const { project, scene, app } = fixture();
    scene.dashboard = { widgets: [{ datasetId: "data" }] } as NonNullable<SceneSnapshot["dashboard"]>;
    app.scenes[0]!.dataBindings = [{ pipelineId: "pipe" }] as NonNullable<SceneSnapshot["dataBindings"]>;
    expect(select(project, [scene], [app]).pipelines).toHaveLength(1);
    expect(select(project, [scene], []).datasets).toHaveLength(1);
  });

  it("does not infer project IDs from direct bindings, samples, or formulas", () => {
    const { project, scene } = fixture();
    scene.dataBindings = [{ directBinding: { endpoint: "/data", datasetId: "data" } }] as unknown as NonNullable<SceneSnapshot["dataBindings"]>;
    expect(select(project, [scene], []).connections).toEqual([]);
  });

  it.each(["missing", "duplicate", "foreign"])("rejects %s datasets with reference paths", failure => {
    const { project, app } = fixture();
    app.data.datasetIds = ["data"];
    if (failure === "missing") project.datasets = [];
    if (failure === "duplicate") project.datasets!.push(structuredClone(project.datasets![0]!));
    if (failure === "foreign") project.datasets![0]!.projectId = "foreign";
    expect(() => select(project, [], [app])).toThrow(/applications\[0\].data.datasetIds\[0\]/);
  });

  it("reports transitive missing connection and source dataset paths", () => {
    const { project, app } = fixture();
    app.data.datasetIds = ["data"];
    project.dataConnections = [];
    expect(() => select(project, [], [app])).toThrow(/connectionId/);
    app.data.datasetIds = [];
    app.scenes[0]!.dataBindings = [{ pipelineId: "pipe" }] as NonNullable<SceneSnapshot["dataBindings"]>;
    project.datasets = [];
    expect(() => select(project, [], [app])).toThrow(/nodes\[0\].datasetId/);
  });

  it.each(["scene", "application", "connection", "pipeline"])("rejects foreign %s ownership", kind => {
    const { project, scene, app } = fixture();
    app.data.connectionIds = ["first"];
    scene.dataBindings = [{ pipelineId: "pipe" }] as NonNullable<SceneSnapshot["dataBindings"]>;
    if (kind === "scene") scene.projectId = "foreign";
    if (kind === "application") app.metadata.projectId = "foreign";
    if (kind === "connection") project.dataConnections![1]!.projectId = "foreign";
    if (kind === "pipeline") project.dataPipelines![0]!.projectId = "foreign";
    expect(() => select(project, [scene], [app])).toThrow(/其他项目/);
  });

  it.each(["cycle", "missing node", "duplicate node"])("rejects pipeline %s", kind => {
    const { project, scene } = fixture();
    scene.dataBindings = [{ pipelineId: "pipe" }] as NonNullable<SceneSnapshot["dataBindings"]>;
    const pipe = project.dataPipelines![0]!;
    if (kind === "cycle") pipe.edges.push({ id: "back", sourceNodeId: "output", targetNodeId: "source" });
    if (kind === "missing node") pipe.edges[0]!.targetNodeId = "missing";
    if (kind === "duplicate node") pipe.nodes.push(structuredClone(pipe.nodes[0]!));
    expect(() => select(project, [scene], [])).toThrow(/管线存在循环|不存在的节点|节点 ID 重复/);
  });

  it("rejects enabled arbitrary scripts but permits disabled scripts and declarative actions", () => {
    const { project, scene } = fixture();
    scene.interactions = [{ enabled: true, code: "fetch(dynamicUrl)", actions: [] }] as unknown as NonNullable<SceneSnapshot["interactions"]>;
    expect(() => select(project, [scene], [])).toThrow(/interactions\[0\].code.*unsupported/);
    scene.interactions![0]!.enabled = false;
    expect(select(project, [scene], []).datasets).toEqual([]);
    scene.interactions![0]!.enabled = true; scene.interactions![0]!.code = "";
    expect(select(project, [scene], []).datasets).toEqual([]);
  });

  it("rejects dynamic data lookups and legacy flows without blocking declared lifecycle data", () => {
    const { project, app } = fixture();
    app.scripts = [{ enabled: true, code: "ctx.getData(key)", runtime: "worker-sandbox", permissions: ["data.read"] }] as typeof app.scripts;
    expect(() => select(project, [], [app])).toThrow(/scripts\[0\].*unsupported/);
    app.scripts[0]!.code = "function onData(ctx) { ctx.log('sample', ctx.data); }";
    expect(select(project, [], [app]).datasets).toEqual([]);
    app.scripts[0]!.code = "ctx.getData('declared.key')";
    expect(select(project, [], [app]).datasets).toEqual([]);
    app.scripts[0]!.permissions = ["network.connect"];
    expect(() => select(project, [], [app])).toThrow(/scripts\[0\].*unsupported/);
    app.interactions = [{ enabled: true, legacyScript: { script: { code: "loadData()" } } }] as typeof app.interactions;
    expect(() => select(project, [], [app])).toThrow(/legacyScript.*unsupported/);
  });

  it("does not silently omit required semantic model configuration", () => {
    const { project, scene } = fixture();
    scene.dashboard = { widgets: [{ semanticBinding: { modelId: "semantic" }, datasetId: "data" }] } as NonNullable<SceneSnapshot["dashboard"]>;
    expect(() => select(project, [scene], [])).toThrow(/semanticBinding.*unsupported/);
  });
});
