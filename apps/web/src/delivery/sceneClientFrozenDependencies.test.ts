import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { PublishedSceneRecord, ScenePublicationDependencies } from "@bim-studio/contracts";
import { frozenSceneResourceUrl, loadFrozenSceneClientDependencies, scenePublicationDependencyIdentity } from "./sceneClientFrozenDependencies";
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../api", () => ({ api: { getScenePublicationDependencies: mocks.load } }));
afterEach(() => { vi.resetAllMocks(); });
const signal = () => new AbortController().signal;
function publication(): PublishedSceneRecord {
  const time = "2026-09-15T12:00:00.000Z";
  return { projectId: "p", sceneId: "s", name: "scene", version: 1, publishedAt: time, snapshot: { schemaVersion: 1, id: "s", projectId: "p", name: "scene",
    models: [], primitives: [], measurements: [], camera: { mode: "orbit", position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 } }, createdAt: time, updatedAt: time } };
}
async function fixture() {
  const source = publication(); const sha256 = "a".repeat(64);
  const record: ScenePublicationDependencies = { schemaVersion: 1, projectId: "p", sceneId: "s", version: 1, publishedAt: source.publishedAt,
    publicationIdentity: await scenePublicationDependencyIdentity(source), inputs: { project: { id: "p", name: "p", description: "", models: [] }, applications: [], runtime: { connections: [], datasets: [], pipelines: [] },
      resources: [{ id: "a", name: "a", url: "/assets/a", claims: [{ bytes: 2, sha256, integrity: `sha256-${Buffer.from(sha256, "hex").toString("base64")}` }] }] },
    resources: [{ sourceUrl: "/assets/a", key: `projects/p/publication-resources/sha256/${sha256}`, bytes: 2, sha256 }] };
  mocks.load.mockResolvedValue(record); return { source, record, sha256 };
}
it("matches independent Node canonical SHA and ignores object key order", async () => {
  const source = publication();
  const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object"
    ? `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}` : JSON.stringify(value);
  const { projectId, sceneId, version, publishedAt, snapshot } = source;
  const expected = createHash("sha256").update(canonical({ projectId, sceneId, version, publishedAt, snapshot })).digest("hex");
  expect(await scenePublicationDependencyIdentity(source)).toBe(expected);
  expect(await scenePublicationDependencyIdentity({ ...source, snapshot: Object.fromEntries(Object.entries(snapshot).reverse()) as typeof snapshot })).toBe(expected);
});
it("loads only exact publication metadata, returns isolated state and resource URLs", async () => {
  const { source, record, sha256 } = await fixture(); const abort = signal();
  const result = await loadFrozenSceneClientDependencies(source, abort);
  expect(mocks.load).toHaveBeenCalledWith("p", "s", 1, abort);
  result.inputs.project.name = "edit"; expect(record.inputs.project.name).toBe("p");
  expect(frozenSceneResourceUrl(record, sha256)).toBe(`/api/projects/p/scenes/s/publications/1/dependencies/resources/${sha256}`);
  expect(() => frozenSceneResourceUrl(record, "b".repeat(64))).toThrow();
});
it("rejects old history without version or frozen record", async () => {
  const source = publication(); delete source.version;
  await expect(loadFrozenSceneClientDependencies(source, signal())).rejects.toThrow("没有冻结"); expect(mocks.load).not.toHaveBeenCalled();
  mocks.load.mockResolvedValue(undefined); await expect(loadFrozenSceneClientDependencies(publication(), signal())).rejects.toThrow("没有冻结");
});
it.each(["version", "snapshot", "foreign", "duplicate", "hash", "bytes", "key", "claim"])("rejects inconsistent %s", async mode => {
  const { source, record } = await fixture();
  if (mode === "version") source.version = 2;
  if (mode === "snapshot") source.snapshot.camera.position.x++;
  if (mode === "foreign") record.inputs.project.id = "other";
  if (mode === "duplicate") record.resources.push(structuredClone(record.resources[0]!));
  if (mode === "hash") record.resources[0]!.sha256 = "A".repeat(64);
  if (mode === "bytes") record.resources[0]!.bytes = -1;
  if (mode === "key") record.resources[0]!.key = "projects/other/x";
  if (mode === "claim") record.inputs.resources[0]!.claims[0]!.integrity = "sha256-bad";
  await expect(loadFrozenSceneClientDependencies(source, signal())).rejects.toThrow();
});
it("honors cancellation and freezes caller input before the metadata wait", async () => {
  const { source, record } = await fixture(); let resolve!: (record: ScenePublicationDependencies) => void;
  mocks.load.mockReturnValue(new Promise<ScenePublicationDependencies>(done => { resolve = done; }));
  const operation = loadFrozenSceneClientDependencies(source, signal()); source.snapshot.camera.position.x++;
  resolve(record); await expect(operation).resolves.toEqual(record);
  const controller = new AbortController(); controller.abort(); mocks.load.mockClear();
  await expect(loadFrozenSceneClientDependencies(publication(), controller.signal)).rejects.toThrow(); expect(mocks.load).not.toHaveBeenCalled();
});

