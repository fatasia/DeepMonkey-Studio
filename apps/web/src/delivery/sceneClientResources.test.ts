import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { migrateSceneSnapshotV1, type ModelRecord, type ProjectAssetRecord, type ProjectRecord, type SceneSnapshot } from "@bim-studio/contracts";
import { selectSceneClientResources, verifySceneClientResource } from "./sceneClientResources";

const scene = (): SceneSnapshot => ({ schemaVersion: 1, id: "scene", projectId: "p", name: "Scene", models: [], primitives: [], measurements: [],
  camera: { mode: "orbit", position: { x: 0, y: 1, z: 5 }, target: { x: 0, y: 0, z: 0 } }, createdAt: "2026-09-15", updatedAt: "2026-09-15" });
const model = (id = "asset"): ModelRecord => ({ id, projectId: "p", name: `${id}.glb`, format: "glb", status: "ready", progress: 100,
  message: "", sourceUrl: "/source.glb", size: 1, createdAt: "", updatedAt: "", manifest: { schemaVersion: 1, modelId: id,
    sourceName: `${id}.glb`, sourceFormat: "glb", geometryUrl: `/models/${id}.glb`, createdAt: "" } });
const asset = (id = "image", url = "/image.png"): ProjectAssetRecord => ({ id, projectId: "p", kind: "image", name: id, fileName: `${id}.png`,
  mimeType: "image/png", size: 3, url, createdAt: "", updatedAt: "" });
const project = (): ProjectRecord => ({ id: "p", name: "Project", description: "", models: [model(), model("unused")], assets: [asset()] } as ProjectRecord);
const instance = (modelId = "instance", assetModelId = "asset"): SceneSnapshot["models"][number] => ({ modelId, assetModelId, name: modelId, visible: true, opacity: 1,
  transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } });

describe("scene client explicit resources", () => {
  it("does not fall back to project resources for an empty scene or match names as URLs", () => {
    const input = scene(); input.name = "description mentions /image.png";
    expect(selectSceneClientResources(project(), [input], [])).toEqual({ models: [], assets: [], resources: [] });
  });
  it("resolves asset identity independently from instances and preserves hidden model references", () => {
    const input = scene(); input.models = [instance(), { ...instance("hidden"), visible: false }];
    const selected = selectSceneClientResources(project(), [input], []);
    expect(selected.models.map(value => value.id)).toEqual(["asset"]);
    expect(selected.resources.map(value => value.url)).toEqual(["/models/asset.glb"]);
  });
  it("supports legacy modelId references and includes declared sidecars and LOD", () => {
    const input = scene(); input.models = [instance("asset")]; delete input.models[0]!.assetModelId;
    const source = project(); Object.assign(source.models[0]!.manifest!, { propertiesUrl: "/props.json", hierarchyUrl: "/tree.json",
      pmiUrl: "/pmi.json", lods: [{ level: "low", ratio: 0.2, url: "/low.glb" }] });
    const selected = selectSceneClientResources(source, [input], []);
    expect(selected.resources.map(value => value.url)).toEqual(expect.arrayContaining(["/models/asset.glb", "/props.json", "/tree.json", "/pmi.json", "/low.glb"]));
  });
  it.each(["missing", "foreign", "not-ready", "no-geometry"])("rejects %s model before transport", reason => {
    const input = scene(); input.models = [instance()]; const source = project();
    if (reason === "missing") source.models = [];
    if (reason === "foreign") source.models[0]!.projectId = "other";
    if (reason === "not-ready") source.models[0]!.status = "processing";
    if (reason === "no-geometry") delete source.models[0]!.manifest!.geometryUrl;
    expect(() => selectSceneClientResources(source, [input], [])).toThrow(/scenes\[0\].models\[0\]/);
  });
  it("matches exact texture URLs and closes material maps with hash claims", () => {
    const input = scene(); input.models = [{ ...instance(), material: { normalMapUrl: "/normal.png" } }];
    const source = project(); source.assets = [{ ...asset("pbr", "/material.json"), kind: "pbr-material",
      maps: [{ kind: "normal", name: "normal.png", url: "/normal.png", size: 3, mimeType: "image/png", contentHash: "a".repeat(64) }] }, asset("prefix", "/normal")];
    const selected = selectSceneClientResources(source, [input], []);
    expect(selected.assets.map(value => value.id)).toEqual(["pbr"]);
    expect(selected.resources.find(value => value.url === "/normal.png")?.claims).toEqual([{ bytes: 3, sha256: "a".repeat(64) }]);
  });
  it("rejects missing or cross-project texture references and ignores embedded data", () => {
    const input = scene(); input.environment = { gridVisible: true, skybox: "none", backgroundColor: "#000000", environmentMapUrl: "/missing.hdr" };
    expect(() => selectSceneClientResources(project(), [input], [])).toThrow(/environment/);
    input.environment.environmentMapUrl = "/image.png";
    const source = project(); source.assets![0]!.projectId = "other";
    expect(() => selectSceneClientResources(source, [input], [])).toThrow(/其他项目/);
    input.environment.environmentMapUrl = "data:image/png;base64,AA==";
    expect(selectSceneClientResources(project(), [input], []).resources).toEqual([]);
  });
  it("deduplicates identical URLs while retaining all byte claims and copies records", () => {
    const input = scene(); input.models = [instance(), instance("second", "unused")];
    const source = project(); source.models[1]!.manifest!.geometryUrl = source.models[0]!.manifest!.geometryUrl!;
    const selected = selectSceneClientResources(source, [input], []);
    expect(selected.resources).toHaveLength(1); expect(selected.models).toHaveLength(2);
    source.models[0]!.name = "Changed";
    expect(selected.models[0]!.name).toBe("asset.glb");
  });
  it("retains and validates declared script dependency bytes", async () => {
    const input = scene(), app = migrateSceneSnapshotV1(input), bytes = new Uint8Array([1, 2, 3]).buffer;
    const integrity = `sha256-${createHash("sha256").update(new Uint8Array(bytes)).digest("base64")}`;
    app.scriptDependencies = [{ id: "d", specifier: "dep", source: "upload", requested: "dep", assetUrl: "/dep.js", fileName: "dep.js", size: 3, integrity, installedAt: "" }];
    const resource = selectSceneClientResources(project(), [input], [app]).resources[0]!;
    await expect(verifySceneClientResource(resource, bytes, new AbortController().signal)).resolves.toBeUndefined();
    await expect(verifySceneClientResource(resource, new Uint8Array([3, 2, 1]).buffer, new AbortController().signal)).rejects.toThrow(/hash/);
    await expect(verifySceneClientResource(resource, new ArrayBuffer(2), new AbortController().signal)).rejects.toThrow(/字节/);
  });
});
