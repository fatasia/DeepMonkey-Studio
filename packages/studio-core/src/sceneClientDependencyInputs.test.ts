import { describe, expect, it } from "vitest";
import { migrateSceneSnapshotV1, type ModelRecord, type ProjectRecord, type SceneSnapshot } from "@bim-studio/contracts";
import { selectSceneClientDependencyInputs as select } from "./sceneClientDependencyInputs.js";

function fixture() {
  const scene: SceneSnapshot = { schemaVersion: 1, id: "root", projectId: "p", name: "Root", models: [], primitives: [], measurements: [],
    camera: { mode: "orbit", position: { x: 0, y: 1, z: 5 }, target: { x: 0, y: 0, z: 0 } }, createdAt: "now", updatedAt: "now" };
  const model = (id: string): ModelRecord => ({ id, projectId: "p", name: id, format: "glb", status: "ready", progress: 100,
    message: "", sourceUrl: "/source.glb", size: 3, createdAt: "now", updatedAt: "now", manifest: { schemaVersion: 1,
      modelId: id, sourceName: id, sourceFormat: "glb", geometryUrl: `/models/${id}.glb`, createdAt: "now" } });
  const project = { id: "p", name: "Project", description: "", models: [model("used"), model("unused")], assets: [],
    dataConnections: ["used", "unused"].map(id => ({ id, projectId: "p", name: id, type: "http", enabled: true,
      config: { url: "https://user:pass@example.com/data?token=secret&limit=10", password: "private", headers: { Authorization: "Bearer private" } } })),
    datasets: [{ id: "dataset", projectId: "p", connectionId: "used", fields: [] }] } as unknown as ProjectRecord;
  const app = migrateSceneSnapshotV1(scene);
  return { scene, project, app };
}
function instance(assetModelId = "used"): SceneSnapshot["models"][number] {
  return { modelId: "instance", assetModelId, name: "Instance", visible: true, opacity: 1,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } };
}

describe("selectSceneClientDependencyInputs", () => {
  it.each([
    ["compatible read-only", "1.0", "studio.scene", "scene.read", false],
    ["future version", "2.0", "studio.scene", "scene.read", true],
    ["unknown capability", "1.0", "studio.unknown", "scene.read", true],
    ["write permission", "1.0", "studio.scene", "scene.write", true],
    ["unknown permission", "1.0", "studio.scene", "unknown.read", true],
  ] as const)("checks %s before freezing script dependencies", (_, apiVersion, capability, permission, rejected) => {
    const { scene, project, app } = fixture();
    app.scripts.push({ id: "worker", name: "Worker", enabled: true, runtime: "worker-sandbox", apiVersion,
      entrypoint: "behavior", code: "opaqueCode()", lifecycle: [], capabilities: [capability], permissions: [permission] } as typeof app.scripts[number]);
    const freeze = () => select(project, scene, [app]);
    if (rejected) expect(freeze).toThrow(/applications\[root\].scripts\[0\]/);
    else expect(freeze().applications[0]!.scripts).toEqual(app.scripts);
  });

  it("keeps an empty scene empty without falling back to project resources", () => {
    const { scene, project } = fixture();
    const result = select(project, scene, []);
    expect(result.project.models).toEqual([]);
    expect(result.project.assets).toEqual([]);
    expect(result.applications).toEqual([]);
    expect(result.runtime).toEqual({ connections: [], datasets: [], pipelines: [] });
    expect(result.resources).toEqual([]);
  });

  it.each(["scene", "application", "model", "dataset"])("rejects a selected cross-project %s", target => {
    const { scene, project, app } = fixture();
    if (target === "scene") scene.projectId = "other";
    if (target === "application") app.metadata.projectId = "other";
    if (target === "model") { scene.models = [instance()]; project.models[0]!.projectId = "other"; }
    if (target === "dataset") { app.data.datasetIds = ["dataset"]; project.datasets![0]!.projectId = "other"; }
    expect(() => select(project, scene, [app])).toThrow(/项目/);
  });

  it("replaces the stale application root and trims unrelated pages, models and declarations", () => {
    const { scene, project, app } = fixture();
    scene.models = [instance()];
    app.scenes[0]!.models = [instance("unused")];
    const other = migrateSceneSnapshotV1({ ...scene, id: "other", models: [instance("unused")] });
    app.pages.push(...other.pages); app.scenes.push(...other.scenes);
    const before = structuredClone({ project, scene, app });
    const result = select(project, scene, [app, migrateSceneSnapshotV1({ ...scene, id: "unrelated" })]);
    expect(result.applications).toHaveLength(1);
    expect(result.applications[0]!.pages.map(page => page.id)).toEqual(["page:root"]);
    expect(result.applications[0]!.scenes.map(value => value.id)).toEqual(["root"]);
    expect(result.project.models.map(model => model.id)).toEqual(["used"]);
    expect(result.resources.map(resource => resource.url)).toEqual(["/models/used.glb"]);
    expect({ project, scene, app }).toEqual(before);
  });

  it("closes selected datasets and strips credentials from the exported metadata", () => {
    const { scene, project, app } = fixture(); app.data.datasetIds = ["dataset"];
    const result = select(project, scene, [app]);
    expect(result.runtime.connections.map(connection => connection.id)).toEqual(["used"]);
    expect(result.runtime.datasets.map(dataset => dataset.id)).toEqual(["dataset"]);
    expect(result.runtime.connections[0]!.config).toEqual({ url: "https://example.com/data?limit=10" });
    expect(project.dataConnections![0]!.config.password).toBe("private");
    expect(JSON.stringify(result)).not.toContain("Bearer private");
  });

  it("isolates every selected nested record from subsequent caller mutations", () => {
    const { scene, project, app } = fixture(); scene.models = [instance()]; app.data.datasetIds = ["dataset"];
    const result = select(project, scene, [app]), before = structuredClone(result);
    project.models[0]!.manifest!.geometryUrl = "/changed.glb";
    project.dataConnections![0]!.config.url = "https://changed.example";
    scene.models[0]!.transform.position.x = 50;
    app.pages[0]!.name = "Changed";
    app.data.datasetIds.length = 0;
    expect(result).toEqual(before);
    result.applications[0]!.scenes[0]!.models[0]!.transform.position.x = 70;
    expect(scene.models[0]!.transform.position.x).toBe(50);
  });

  it("deduplicates a shared model URL while preserving both resource claims", () => {
    const { scene, project } = fixture();
    scene.models = [instance(), { ...instance("unused"), modelId: "second" }];
    project.models[1]!.manifest!.geometryUrl = "/models/used.glb";
    const result = select(project, scene, []);
    expect(result.project.models).toHaveLength(2);
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]!.claims).toHaveLength(2);
  });

  it.each([
    "/assets/projects/p/geometry.glb?token=private",
    "/assets/projects/p/geometry.glb?X-Amz-Signature=private",
    "https://user:private@example.com/geometry.glb",
    "/assets/projects/p/geometry.glb?authorization=private",
  ])("rejects resource URLs changed by credential sanitization: %s", url => {
    const { scene, project } = fixture(); scene.models = [instance()];
    project.models[0]!.manifest!.geometryUrl = url;
    expect(() => select(project, scene, [])).toThrow(/model-used.*无法稳定冻结/);
    expect(project.models[0]!.manifest!.geometryUrl).toBe(url);
  });

  it("keeps plain static model and sidecar aliases identical to the selected resource URLs", () => {
    const { scene, project } = fixture(); scene.models = [instance()];
    const manifest = project.models[0]!.manifest!;
    manifest.geometryUrl = "/assets/projects/p/models/used/geometry.glb";
    manifest.propertiesUrl = "/assets/projects/p/models/used/properties.json";
    const result = select(project, scene, []);
    expect(result.resources.map(resource => resource.url)).toEqual([
      result.project.models[0]!.manifest!.geometryUrl,
      result.project.models[0]!.manifest!.propertiesUrl,
    ]);
  });

  it("trims asset declarations per application and preserves kind-qualified identities", () => {
    const { scene, project, app } = fixture(); scene.models = [instance()];
    const url = "/assets/projects/p/image.png";
    project.assets = [{ id: "used", projectId: "p", kind: "image", name: "Image", fileName: "image.png",
      mimeType: "image/png", url, size: 3, createdAt: "now", updatedAt: "now" }];
    app.assets = [{ id: "used", projectId: "p", kind: "model" }, { id: "used", projectId: "p", kind: "image" }];
    const second = structuredClone(app); second.metadata.id = "second";
    second.pages[0]!.appearance = { backgroundImageUrl: url };
    const result = select(project, scene, [app, second]);
    expect(result.applications[0]!.assets).toEqual([{ id: "used", projectId: "p", kind: "model" }]);
    expect(result.applications[1]!.assets).toEqual(app.assets);
    expect(result.project.assets).toHaveLength(1);
    expect(app.assets).toHaveLength(2);
  });

  it("rejects a signed page image without mutating the original page", () => {
    const { scene, project, app } = fixture();
    const url = "/assets/projects/p/image.png?signature=private";
    project.assets = [{ id: "image", projectId: "p", kind: "image", name: "Image", fileName: "image.png",
      mimeType: "image/png", url, size: 3, createdAt: "now", updatedAt: "now" }];
    app.pages[0]!.appearance = { backgroundImageUrl: url };
    expect(() => select(project, scene, [app])).toThrow(/asset-image.*无法稳定冻结/);
    expect(app.pages[0]!.appearance.backgroundImageUrl).toBe(url);
  });
});
