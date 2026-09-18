import { createHash } from "node:crypto";
import JSZip from "jszip";
import { afterEach, expect, it, vi } from "vitest";
import { selectSceneClientDependencyInputs } from "@bim-studio/studio-core";
import type { ProjectRecord, PublishedSceneRecord, ScenePublicationDependencies } from "@bim-studio/contracts";
import { exportSceneClientPackage, prepareSceneClientPackage } from "./sceneClientPackage";
import { scenePublicationDependencyIdentity } from "./sceneClientFrozenDependencies";
const mocks = vi.hoisted(() => ({ project: vi.fn(), apps: vi.fn(), metadata: vi.fn(), bytes: vi.fn(), raw: vi.fn(), download: vi.fn() }));
vi.mock("../api", () => ({ api: { getProject: mocks.project, listApplications: mocks.apps, getScenePublicationDependencies: mocks.metadata, loadScenePublicationResource: mocks.bytes } }));
vi.mock("../viewer/viewerAssetTransport", () => ({ loadViewerAssetBuffer: mocks.raw }));
vi.mock("../browserDownload", () => ({ downloadBlob: mocks.download }));
afterEach(() => { vi.resetAllMocks(); });
async function fixture() {
 const at = "2026-09-15T12:00:00.000Z";
 const publication: PublishedSceneRecord = { projectId: "p", sceneId: "s", version: 1, name: "old", publishedAt: at,
 snapshot: { schemaVersion: 1, id: "s", projectId: "p", name: "old", models: [{ modelId: "instance", assetModelId: "asset", name: "old", visible: true, opacity: 1,
 transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }], primitives: [], measurements: [],
 camera: { mode: "orbit", position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 } }, createdAt: at, updatedAt: at, publishedAt: at } };
 const project = { id: "p", name: "Original", models: [{ id: "asset", projectId: "p", status: "ready", name: "old.glb", manifest: { geometryUrl: "/original.glb" } }] } as ProjectRecord;
 const bytes = new Uint8Array([11, 22, 33]); const sha256 = createHash("sha256").update(bytes).digest("hex");
 const record: ScenePublicationDependencies = { schemaVersion: 1, projectId: "p", sceneId: "s", version: 1, publishedAt: at,
 publicationIdentity: await scenePublicationDependencyIdentity(publication), inputs: selectSceneClientDependencyInputs(project, publication.snapshot, []),
 resources: [{ sourceUrl: "/original.glb", key: `projects/p/publication-resources/sha256/${sha256}`, bytes: 3, sha256 }] };
 mocks.metadata.mockResolvedValue(record); mocks.bytes.mockResolvedValue(bytes.buffer);
 for (const mock of [mocks.project, mocks.apps, mocks.raw]) mock.mockRejectedValue(new Error("current dependency forbidden"));
 const options = { projectId: "p", scene: publication.snapshot, publication, target: "three-webview" as const, renderer: "webgl" as const, toolbarVisible: true };
 return { publication, project, record, bytes, options };
}
it("exports original bytes into a real ZIP without reading mutable project/apps/URLs", async () => {
 const { options, bytes } = await fixture(); await exportSceneClientPackage(options);
 const zip = await JSZip.loadAsync(await (mocks.download.mock.lastCall![0] as Blob).arrayBuffer(), { checkCRC32: true });
 const project = JSON.parse(await zip.file("project.json")!.async("string"));
 expect(project.name).toBe("Original"); expect(await zip.file(project.models[0].manifest.geometryUrl)!.async("uint8array")).toEqual(bytes);
 expect(mocks.project).not.toHaveBeenCalled(); expect(mocks.apps).not.toHaveBeenCalled(); expect(mocks.raw).not.toHaveBeenCalled();
 expect(mocks.bytes).toHaveBeenCalledTimes(1);
});
it.each(["source", "hash", "version", "missing", "scene"])("blocks %s without download", async mode => {
 const { options, record, publication } = await fixture();
 if (mode === "source") publication.snapshot.camera.position.x++;
 if (mode === "hash") mocks.bytes.mockResolvedValue(new Uint8Array([99, 22, 33]).buffer);
 if (mode === "version") delete publication.version;
 if (mode === "missing") mocks.metadata.mockResolvedValue(undefined);
 if (mode === "scene") options.scene = { ...options.scene, name: "different" };
 await expect(exportSceneClientPackage(options)).rejects.toThrow(); expect(mocks.download).not.toHaveBeenCalled();
 expect(record.version).toBe(1);
});
it.each([true, false])("prepared delivery verifies frozen dependency equality: %s", async equal => {
 const { options, project, bytes, record } = await fixture();
 mocks.project.mockResolvedValue(project); mocks.apps.mockResolvedValue([]); mocks.raw.mockResolvedValue(bytes.buffer);
 const { publication: _publication, ...draft } = options; const prepared = await prepareSceneClientPackage(draft);
 mocks.project.mockClear(); mocks.apps.mockClear(); mocks.raw.mockClear();
 if (!equal) record.inputs.project.name = "Changed on server";
 const operation = exportSceneClientPackage({ ...options, prepared });
 if (equal) { await operation; expect(mocks.download).toHaveBeenCalledTimes(1); }
 else { await expect(operation).rejects.toThrow(); expect(mocks.download).not.toHaveBeenCalled(); }
 expect(mocks.bytes).not.toHaveBeenCalled(); expect(mocks.raw).not.toHaveBeenCalled(); expect(mocks.project).not.toHaveBeenCalled();
});

it("keeps publication identity stable when a progress callback changes caller-owned input", async () => {
 const { options, publication } = await fixture();
 await exportSceneClientPackage({ ...options, progress: () => {
  publication.version = 2;
  publication.snapshot.name = "new draft";
 } });
 expect(mocks.metadata).toHaveBeenCalledTimes(2);
 for (const call of mocks.metadata.mock.calls) expect(call.slice(0, 3)).toEqual(["p", "s", 1]);
 const zip = await JSZip.loadAsync(await (mocks.download.mock.lastCall![0] as Blob).arrayBuffer());
 expect(JSON.parse(await zip.file("scene.json")!.async("string")).name).toBe("old");
});
