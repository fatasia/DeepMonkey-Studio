import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { migrateSceneSnapshotV1 } from "@bim-studio/contracts";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { exportSceneClientPackage, type SceneClientPackageOptions } from "./sceneClientPackage";

const mocks = vi.hoisted(() => ({ project: vi.fn(), applications: vi.fn(), load: vi.fn(), download: vi.fn() }));
vi.mock("../api", () => ({ api: { getProject: mocks.project, listApplications: mocks.applications } }));
vi.mock("../browserDownload", () => ({ downloadBlob: mocks.download }));
vi.mock("../viewer/viewerAssetTransport", () => ({ loadViewerAssetBuffer: mocks.load }));

interface ManifestEntry { path: string; bytes: number; sha256: string }
interface Manifest extends Record<string, unknown> {
  generatedAt: string;
  files: ManifestEntry[];
  contentHash: { algorithm: string; value: string };
}
let cancellation = new AbortController();
const active = new Set<Promise<unknown>>();
it("passes actual exporter bytes through the repository consumer CLI", async () => {
  const { manifest } = await archive();
  const directory = await mkdtemp(join(tmpdir(), "scene-export-consumer-"));
  try {
    const path = join(directory, "scene.bimscene.zip");
    await writeFile(path, new Uint8Array(await (mocks.download.mock.lastCall![0] as Blob).arrayBuffer()));
    const cli = fileURLToPath(new URL("../../../../scripts/verify-scene-client-package.mjs", import.meta.url));
    const result = await promisify(execFile)(process.execPath, [cli, path, "--target", "three-webview"]);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "integrity-verified", fileCount: manifest.files.length,
      contentHash: manifest.contentHash.value });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
function options(): SceneClientPackageOptions {
  return { projectId: "project", target: "three-webview", renderer: "webgl", toolbarVisible: true, signal: cancellation.signal,
    scene: { schemaVersion: 1, id: "scene", projectId: "project", name: "Manifest", models: [], primitives: [], measurements: [],
      camera: { mode: "orbit", position: { x: 0, y: 1, z: 5 }, target: { x: 0, y: 0, z: 0 } },
      createdAt: "2026-09-14T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z", publishedAt: "2026-09-15T00:00:00Z" } };
}
async function archive(input = options()) {
  const task = exportSceneClientPackage(input);
  active.add(task);
  try { await task; } finally { active.delete(task); }
  const blob = mocks.download.mock.lastCall![0] as Blob;
  const zip = await JSZip.loadAsync(await blob.arrayBuffer(), { checkCRC32: true });
  const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as Manifest;
  return { zip, manifest };
}
function digest(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }
function contentHash(manifest: Manifest, entries = manifest.files): string {
  const { files: _files, contentHash: _hash, generatedAt: _generatedAt, ...metadata } = manifest;
  return runtimeContentSha256({ metadata, files: entries.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) });
}
beforeEach(() => {
  cancellation = new AbortController();
  mocks.project.mockResolvedValue({ id: "project", name: "Project", models: [] });
  mocks.applications.mockResolvedValue([]);
});
afterEach(async () => {
  cancellation.abort();
  await Promise.allSettled(active);
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("scene package content manifest", () => {
  it("indexes every actual non-directory payload with sorted paths and independently verifiable bytes", async () => {
    const { zip, manifest } = await archive();
    const actualPaths = Object.values(zip.files).filter(file => !file.dir).map(file => file.name).sort();
    const paths = manifest.files.map(file => file.path);
    expect(paths).toEqual([...paths].sort());
    expect(new Set(paths).size).toBe(paths.length);
    expect(actualPaths).toEqual([...paths, "manifest.json"].sort());
    expect(paths).toEqual(expect.arrayContaining(["scene.json", "project.json", "applications.json", "runtime.json", "README.txt"]));
    expect(paths).not.toContain("manifest.json");
    for (const entry of manifest.files) {
      const bytes = await zip.file(entry.path)!.async("uint8array");
      expect(entry.bytes).toBe(bytes.byteLength);
      expect(entry.sha256).toBe(digest(bytes));
    }
    expect(manifest.contentHash).toEqual({ algorithm: "sha256", value: contentHash(manifest) });
  });

  it("keeps archive timestamps and content identity stable across wall-clock changes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T00:00:00Z"));
    const first = await archive();
    vi.setSystemTime(new Date("2026-09-17T05:00:00Z"));
    const second = await archive();
    expect(first.manifest.generatedAt).toBe("2026-09-15T00:00:00.000Z");
    expect(second.manifest.generatedAt).toBe(first.manifest.generatedAt);
    expect(second.zip.file("scene.json")!.date.getTime()).toBe(first.zip.file("scene.json")!.date.getTime());
    expect(first.manifest.contentHash).toEqual(second.manifest.contentHash);
    expect(first.manifest.files).toEqual(second.manifest.files);
  });

  it.each(["runtime", "renderer"])("changes content identity when %s changes", async (field) => {
    const input = options();
    const project = { id: "project", name: "Project", models: [],
      dataConnections: [{ id: "connection-1", projectId: "project", name: "Simulation", type: "simulation", enabled: true, config: {} }],
      datasets: [{ id: "dataset-1", projectId: "project", connectionId: "connection-1", name: "Original runtime", fields: [] }] };
    if (field === "runtime") {
      const app = migrateSceneSnapshotV1(input.scene); app.data.datasetIds = ["dataset-1"];
      mocks.applications.mockResolvedValue([app]); mocks.project.mockResolvedValue(project);
    }
    const first = await archive(input);
    if (field === "runtime") project.datasets[0]!.name = "Updated runtime";
    else input.renderer = "webgpu-preferred";
    const second = await archive(input);
    expect(first.manifest.contentHash.value).not.toBe(second.manifest.contentHash.value);
    expect(second.manifest.contentHash.value).toBe(contentHash(second.manifest));
  });

  it("ignores unreferenced project datasets when computing package content identity", async () => {
    const first = await archive();
    mocks.project.mockResolvedValue({ id: "project", name: "Project", models: [],
      dataConnections: [{ id: "unused-connection", projectId: "project", name: "Unused", type: "simulation", enabled: true, config: {} }],
      datasets: [{ id: "unused-dataset", projectId: "project", connectionId: "unused-connection", name: "Unrelated runtime", fields: [] }] });
    const second = await archive();
    expect(second.manifest.contentHash).toEqual(first.manifest.contentHash);
    const runtime = JSON.parse(await second.zip.file("runtime.json")!.async("string"));
    expect(runtime.datasets).toEqual([]); expect(runtime.connections).toEqual([]);
  });

  it.each(["scene.json", "runtime.json", "README.txt"])("detects a single-byte change in %s", async (path) => {
    const { zip, manifest } = await archive();
    const bytes = await zip.file(path)!.async("uint8array");
    const changed = bytes.slice();
    changed[0] = changed[0]! ^ 1;
    expect(changed.byteLength).toBe(bytes.byteLength);
    const entry = manifest.files.find(file => file.path === path)!;
    expect(entry.sha256).not.toBe(digest(changed));
    const alteredEntries = manifest.files.map(file => file.path === path ? { ...file, sha256: digest(changed) } : file);
    expect(contentHash(manifest, alteredEntries)).not.toBe(manifest.contentHash.value);
  });
});
