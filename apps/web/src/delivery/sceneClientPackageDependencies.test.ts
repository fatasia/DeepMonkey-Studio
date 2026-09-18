import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { migrateSceneSnapshotV1, type ProjectRecord, type SceneSnapshot } from "@bim-studio/contracts";
import { exportSceneClientPackage } from "./sceneClientPackage";

const mocks = vi.hoisted(() => ({ project: vi.fn(), applications: vi.fn(), load: vi.fn(), download: vi.fn() }));
vi.mock("../api", () => ({ api: { getProject: mocks.project, listApplications: mocks.applications } }));
vi.mock("../browserDownload", () => ({ downloadBlob: mocks.download }));
vi.mock("../viewer/viewerAssetTransport", () => ({ loadViewerAssetBuffer: mocks.load }));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const blobs = new Map([ ["/model.glb", new Uint8Array([1, 2, 3])], ["/material.png", new Uint8Array([4, 5])],
    ["/normal.png", new Uint8Array([6, 7, 8])], ["/dependency.js", new TextEncoder().encode("export const value=1;")] ]);
  const scene = { schemaVersion: 1, id: "root", projectId: "project", name: "Root", models: [{ modelId: "instance", assetModelId: "asset",
    name: "Model", visible: true, opacity: 1, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
    material: { normalMapUrl: "/normal.png" } }], primitives: [], measurements: [],
    camera: { mode: "orbit", position: { x: 0, y: 1, z: 5 }, target: { x: 0, y: 0, z: 0 } },
    dataBindings: [{ id: "binding", name: "Data", enabled: true, datasetId: "dataset", field: "value", target: {}, action: "label", refreshSeconds: 1 }],
    createdAt: "2026-09-15T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z" } as SceneSnapshot;
  const project = { id: "project", name: "Project", models: [
    { id: "asset", projectId: "project", status: "ready", name: "Model.glb", manifest: { geometryUrl: "/model.glb" } },
    { id: "unused", projectId: "project", status: "ready", name: "Unused.glb", manifest: { geometryUrl: "/unused.glb" } }],
  assets: [{ id: "material", projectId: "project", kind: "pbr-material", name: "Material", fileName: "material.png", url: "/material.png", size: 2,
    maps: [{ kind: "normal", name: "normal.png", url: "/normal.png", size: 3, contentHash: hash(blobs.get("/normal.png")!) }] },
    { id: "alias", projectId: "project", kind: "image", name: "Alias", fileName: "alias.png", url: "/material.png", size: 2 },
    { id: "unused", projectId: "project", kind: "image", url: "/unused.png", size: 1 }],
  datasets: [{ id: "dataset", projectId: "project", connectionId: "connection", fields: [] },
    { id: "unused", projectId: "project", connectionId: "unused", fields: [] }],
  dataConnections: [{ id: "connection", projectId: "project", name: "Connection", type: "simulation", config: {}, enabled: true },
    { id: "unused", projectId: "project", name: "Unused", type: "simulation", config: {}, enabled: true }], dataPipelines: [] } as unknown as ProjectRecord;
  const app = migrateSceneSnapshotV1(scene);
  app.pages[0]!.appearance = { backgroundImageUrl: "/material.png" };
  const unrelatedScene = structuredClone(scene); unrelatedScene.id = "unrelated";
  unrelatedScene.models[0]!.assetModelId = "unused"; delete unrelatedScene.models[0]!.material;
  unrelatedScene.dataBindings![0]!.datasetId = "unused";
  const unrelated = migrateSceneSnapshotV1(unrelatedScene);
  app.pages.push(structuredClone(unrelated.pages[0]!)); app.scenes.push(structuredClone(unrelated.scenes[0]!));
  app.scriptDependencies = [{ id: "dependency", specifier: "fixture", source: "upload", requested: "fixture", fileName: "dependency.js",
    assetUrl: "/dependency.js", integrity: `sha256-${createHash("sha256").update(blobs.get("/dependency.js")!).digest("base64")}`,
    size: blobs.get("/dependency.js")!.length, installedAt: scene.updatedAt }];
  mocks.project.mockResolvedValue(project); mocks.applications.mockResolvedValue([app, unrelated]);
  mocks.load.mockImplementation(async (url: string) => {
    const bytes = blobs.get(url); if (!bytes) throw new Error(`Unexpected resource ${url}`);
    return Uint8Array.from(bytes).buffer;
  });
  const run = () => exportSceneClientPackage({ projectId: "project", scene, target: "three-webview", renderer: "webgl", toolbarVisible: true });
  return { project, scene, app, blobs, run };
}

beforeEach(() => { vi.clearAllMocks(); vi.spyOn(JSZip.prototype, "generateAsync"); });
afterEach(() => vi.restoreAllMocks());

describe("scene client dependency integration", () => {
  it("prunes asset declarations per application and keeps model and image identities separate", async () => {
    const { app, run } = fixture();
    const other = structuredClone(app); other.metadata.id = "other-view";
    const declaration = { id: "alias", kind: "image" as const, projectId: "project" };
    app.assets.push(declaration, { id: "asset", kind: "image", projectId: "project" });
    other.assets.push(declaration);
    delete app.pages[0]!.appearance;
    mocks.applications.mockResolvedValue([app, other]);
    await run();
    const zip = await JSZip.loadAsync(await (mocks.download.mock.lastCall![0] as Blob).arrayBuffer());
    const applications = JSON.parse(await zip.file("applications.json")!.async("string"));
    expect(applications[0].assets).toEqual([{ id: "asset", kind: "model", projectId: "project" }]);
    expect(applications[1].assets).toContainEqual(declaration);
  });
  it("writes only reachable content into a real ZIP and downloads each aliased URL once", async () => {
    const { run, blobs } = fixture();
    await run();
    expect(mocks.load.mock.calls.map(call => call[0])).toEqual(["/model.glb", "/material.png", "/normal.png", "/dependency.js"]);
    const zip = await JSZip.loadAsync(await (mocks.download.mock.calls[0]![0] as Blob).arrayBuffer(), { checkCRC32: true });
    const json = async (path: string) => JSON.parse(await zip.file(path)!.async("string"));
    const project = await json("project.json"), apps = await json("applications.json"), runtime = await json("runtime.json");
    expect(project.models.map((item: { id: string }) => item.id)).toEqual(["asset"]);
    expect(project.assets.map((item: { id: string }) => item.id)).toEqual(["material", "alias"]);
    expect(apps).toHaveLength(1);
    expect(apps[0].pages.map((page: { id: string }) => page.id)).toEqual(["page:root"]);
    expect(apps[0].scenes.map((scene: { id: string }) => scene.id)).toEqual(["root"]);
    expect(runtime.datasets.map((item: { id: string }) => item.id)).toEqual(["dataset"]);
    expect(runtime.connections.map((item: { id: string }) => item.id)).toEqual(["connection"]);
    expect(runtime.pipelines).toEqual([]);
    expect((await json("scene.json")).models[0]).toMatchObject({ modelId: "instance", assetModelId: "asset" });
    expect(project.assets[1].url).toBe(project.assets[0].url);
    expect(apps[0].pages[0].appearance.backgroundImageUrl).toBe(project.assets[0].url);
    expect((await json("scene.json")).models[0].material.normalMapUrl).toBe(project.assets[0].maps[0].url);
    const manifest = await json("manifest.json");
    for (const file of manifest.files) {
      const content = await zip.file(file.path)!.async("uint8array");
      expect(content.byteLength).toBe(file.bytes); expect(hash(content)).toBe(file.sha256);
      if (blobs.has(file.sourceUrl)) expect(content).toEqual(blobs.get(file.sourceUrl));
    }
    expect(await zip.file(apps[0].scriptDependencies[0].assetUrl)!.async("uint8array")).toEqual(blobs.get("/dependency.js"));
  });

  it("keeps an empty scene empty even when the project contains populated apps and assets", async () => {
    const { scene, run } = fixture(); scene.id = "empty"; scene.models = []; delete scene.dataBindings;
    await run(); expect(mocks.load).not.toHaveBeenCalled();
    const zip = await JSZip.loadAsync(await (mocks.download.mock.calls[0]![0] as Blob).arrayBuffer());
    const project = JSON.parse(await zip.file("project.json")!.async("string"));
    expect(project.models).toEqual([]); expect(project.assets).toEqual([]);
    expect(JSON.parse(await zip.file("applications.json")!.async("string"))).toEqual([]);
    expect(JSON.parse(await zip.file("runtime.json")!.async("string"))).toMatchObject({ connections: [], datasets: [], pipelines: [] });
  });

  it.each(["missing model", "foreign model", "missing asset", "foreign asset"])("blocks %s before fetching or generating ZIP", async kind => {
    const { project, run } = fixture();
    if (kind === "missing model") project.models = project.models.filter(model => model.id !== "asset");
    if (kind === "foreign model") project.models[0]!.projectId = "foreign";
    if (kind === "missing asset") project.assets = [];
    if (kind === "foreign asset") project.assets![0]!.projectId = "foreign";
    await expect(run()).rejects.toThrow(/客户端资源/);
    expect(mocks.load).not.toHaveBeenCalled(); expect(JSZip.prototype.generateAsync).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  });

  it.each(["texture", "dependency"])("blocks corrupt %s bytes after the relevant fetch, before ZIP or download", async kind => {
    const { blobs, run } = fixture(); const url = kind === "texture" ? "/normal.png" : "/dependency.js";
    const bytes = blobs.get(url)!; bytes[0] = bytes[0]! ^ 1;
    await expect(run()).rejects.toThrow(/hash 不匹配/);
    expect(mocks.load).toHaveBeenCalledTimes(kind === "texture" ? 3 : 4);
    expect(JSZip.prototype.generateAsync).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  });
});
