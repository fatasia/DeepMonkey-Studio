import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import JSZip from "jszip";
import { exportSceneClientPackage, prepareSceneClientPackage, type SceneClientPackageOptions } from "./sceneClientPackage";
// 真实编译器在收集阶段完成转换；下方只替换运行证据，不替换编译产物。
import { prepareNativeSceneClientPayload } from "./nativeSceneClientPayload";

const mocks = vi.hoisted(() => ({ project: vi.fn(), applications: vi.fn(), load: vi.fn(), download: vi.fn(), degraded: false }));
vi.mock("../api", () => ({ api: { getProject: mocks.project, listApplications: mocks.applications } }));
vi.mock("../browserDownload", () => ({ downloadBlob: mocks.download }));
vi.mock("../viewer/viewerAssetTransport", () => ({ loadViewerAssetBuffer: mocks.load }));
vi.mock("./nativeSceneClientPayload", async () => {
  const actual = await vi.importActual<typeof import("./nativeSceneClientPayload")>("./nativeSceneClientPayload");
  const { summarizeScenePublicationCompatibility } = await vi.importActual<typeof import("@bim-studio/contracts")>("@bim-studio/contracts");
  return { prepareNativeSceneClientPayload: vi.fn(async (...args: Parameters<typeof actual.prepareNativeSceneClientPayload>) => {
    const native = await actual.prepareNativeSceneClientPayload(...args);
    const source = native.report;
    // 仅用于验证 ready 分支的证据替身，不是实际 Native 窗口验证结果。
    const evidence = source.items.map((item, index) => ({ id: `test-only-window-${index}`, capability: item.capability,
      target: source.target, sourceSemanticHash: source.contentFingerprint, compileGraphHash: source.compileGraphHash,
      targetArtifactHash: source.targetArtifactHash, fixtureId: source.fixtureId, platform: source.platform, scope: "native-window" as const }));
    const report = summarizeScenePublicationCompatibility({ ...source, evidence,
      profile: { version: source.capabilityProfileVersion, capabilities: [...new Set(source.items.map(item => item.capability))] },
      items: source.items.map((item, index) => ({ ...item, status: mocks.degraded && index === 0 ? "degraded" : "supported",
        reason: "测试专用窗口证据替身", remediation: "审核测试降级项", evidenceIds: [evidence[index]!.id] })) });
    return { ...native, report, manifest: { ...native.manifest, status: report.status },
      files: native.files.map(file => file.path === "native/compatibility-report.json"
        ? { ...file, content: JSON.stringify(report, null, 2) } : file) };
  }) };
});

let cancellation = new AbortController();
const pending = new Set<Promise<unknown>>();
interface MutableNativeFixture {
  id: string;
  packageHash: { value: string };
  nativeRuntime: { packageHash: { value: string } };
  sourceSemanticHash: string;
  targetArtifactHash: string;
  items: Array<{ capability: string }>;
  evidence: Array<{ scope: string }>;
  camera: { position: { x: number } };
  objectBindings: unknown[];
  sourceAssets: unknown[];
}
async function verifyZip(zip: JSZip) {
  const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
  // 故意重封外层摘要，确保反例由内包/证据一致性拒绝，而非仅由 ZIP 哈希拒绝。
  for (const file of manifest.files) {
    const bytes = await zip.file(file.path)!.async("nodebuffer");
    file.bytes = bytes.length; file.sha256 = createHash("sha256").update(bytes).digest("hex");
  }
  const { files, contentHash: _hash, generatedAt: _time, ...metadata } = manifest;
  manifest.contentHash.value = runtimeContentSha256({ metadata,
    files: files.map(({ path, bytes, sha256 }: { path: string; bytes: number; sha256: string }) => ({ path, bytes, sha256 })) });
  zip.file("manifest.json", JSON.stringify(manifest));
  const directory = await mkdtemp(join(tmpdir(), "native-client-consumer-"));
  try {
    const path = join(directory, "native.bimscene.zip");
    await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
    const cli = fileURLToPath(new URL("../../../../scripts/verify-scene-client-package.mjs", import.meta.url));
    const result = await promisify(execFile)(process.execPath, [cli, path, "--target", "deep-native"]);
    return JSON.parse(result.stdout);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
function track<T>(promise: Promise<T>): Promise<T> {
  pending.add(promise);
  void promise.then(() => pending.delete(promise), () => pending.delete(promise));
  return promise;
}
function options(): SceneClientPackageOptions {
  return { projectId: "project", target: "deep-native", renderer: "webgl", toolbarVisible: true, signal: cancellation.signal,
    scene: { schemaVersion: 1, id: "scene", projectId: "project", name: "Prepared Native", primitives: [], measurements: [],
      models: [{ modelId: "instance", assetModelId: "asset", name: "Box", visible: true, opacity: 1,
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }],
      camera: { mode: "orbit", position: { x: 0, y: 2, z: 5 }, target: { x: 0, y: 0, z: 0 } },
      createdAt: "2026-09-14T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z" } };
}
beforeEach(() => {
  cancellation = new AbortController();
  mocks.degraded = false;
  mocks.project.mockResolvedValue({ id: "project", name: "Project", models: [{ id: "asset", projectId: "project", status: "ready", name: "Box.glb", manifest: { geometryUrl: "/box.glb" } }] });
  mocks.applications.mockResolvedValue([]);
  const bytes = readFileSync(new URL("../../../../packages/deep-engine/lab/assets/Box.glb", import.meta.url));
  mocks.load.mockResolvedValue(Uint8Array.from(bytes).buffer);
});
afterEach(async () => {
  cancellation.abort();
  await Promise.allSettled(pending);
  vi.clearAllMocks();
});

describe("prepared Native package with test-only window evidence", () => {
  it("reuses one real compilation and resource read across publication timestamps and real ZIP delivery", async () => {
    const input = options();
    const prepared = await track(prepareSceneClientPackage(input));
    expect(mocks.download).not.toHaveBeenCalled();
    expect(prepareNativeSceneClientPayload).toHaveBeenCalledTimes(1);
    const native: Awaited<ReturnType<typeof prepareNativeSceneClientPayload>> = await vi.mocked(prepareNativeSceneClientPayload).mock.results[0]!.value;
    expect(native.report.status).toBe("ready");
    const sourceEvidence = native.files.find(file => file.path === "native/compilation-evidence.json")!.content;
    input.scene.publishedAt = "2026-09-16T01:00:00Z";
    input.scene.updatedAt = input.scene.publishedAt;
    await track(exportSceneClientPackage({ ...input, prepared }));
    expect(prepareNativeSceneClientPayload).toHaveBeenCalledTimes(1);
    expect(mocks.project).toHaveBeenCalledTimes(1);
    expect(mocks.applications).toHaveBeenCalledTimes(1);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.download).toHaveBeenCalledTimes(1);
    const blob = mocks.download.mock.calls[0]![0] as Blob;
    const zip = await JSZip.loadAsync(await blob.arrayBuffer(), { checkCRC32: true });
    expect(JSON.parse(await zip.file("scene.json")!.async("string"))).toMatchObject({
      publishedAt: input.scene.publishedAt, updatedAt: input.scene.updatedAt });
    expect(await zip.file("native/compilation-evidence.json")!.async("string")).toBe(sourceEvidence);
    const packageJson = await zip.file("native/runtime-package.json")!.async("string");
    expect(packageJson).toBe(native.files.find(file => file.path === "native/runtime-package.json")!.content);
    const report = JSON.parse(await zip.file("native/compatibility-report.json")!.async("string"));
    expect(report).toEqual(native.report);
    expect(report.targetArtifactHash).toBe(createHash("sha256").update(packageJson).digest("hex"));
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    expect(manifest.nativeRuntime.status).toBe("ready");
    expect(manifest.publishedAt).toBe(input.scene.publishedAt);
    expect(await verifyZip(zip)).toMatchObject({ status: "integrity-verified", target: "deep-native" });
  });

  it.each([
    ["native/runtime-package.json", (value: MutableNativeFixture) => { value.packageHash.value = "0".repeat(64); }],
    ["native/compilation-evidence.json", (value: MutableNativeFixture) => { value.sourceSemanticHash = "0".repeat(64); }],
    ["native/compilation-evidence.json", (value: MutableNativeFixture) => { value.objectBindings = []; }],
    ["native/compilation-evidence.json", (value: MutableNativeFixture) => { value.sourceAssets = []; }],
    ["native/compatibility-report.json", (value: MutableNativeFixture) => { value.targetArtifactHash = "0".repeat(64); }],
    ["native/compatibility-report.json", (value: MutableNativeFixture) => { value.items = []; }],
    ["native/compatibility-report.json", (value: MutableNativeFixture) => { value.items = value.items.filter(item => item.capability !== "deep.scene.static-glb.v1"); }],
    ["native/compatibility-report.json", (value: MutableNativeFixture) => { value.evidence[0]!.scope = "web-runtime"; }],
    ["scene.json", (value: MutableNativeFixture) => { value.camera.position.x = 999; }],
    ["project.json", (value: MutableNativeFixture) => { value.id = "other-project"; }],
    ["manifest.json", (value: MutableNativeFixture) => { value.nativeRuntime.packageHash.value = "0".repeat(64); }],
  ])("rejects mismatched %s after valid outer hashes are rebuilt", async (path, mutate) => {
    await track(exportSceneClientPackage(options()));
    const blob = mocks.download.mock.lastCall![0] as Blob;
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const value = JSON.parse(await zip.file(path)!.async("string"));
    mutate(value); zip.file(path, JSON.stringify(value));
    await expect(verifyZip(zip)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Native 包内容不一致") });
  });

  it("rejects camera changes after preparation without recompilation or download", async () => {
    const input = options(), prepared = await track(prepareSceneClientPackage(input));
    input.scene.camera.position.x++;
    await expect(track(exportSceneClientPackage({ ...input, prepared }))).rejects.toThrow("已变化");
    expect(prepareNativeSceneClientPayload).toHaveBeenCalledTimes(1);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("does not prepare a deliverable handle when matching test evidence still requires confirmation", async () => {
    mocks.degraded = true;
    await expect(track(prepareSceneClientPackage(options()))).rejects.toMatchObject({ code: "publication-confirmation-required" });
    expect(prepareNativeSceneClientPayload).toHaveBeenCalledTimes(1);
    expect(mocks.download).not.toHaveBeenCalled();
  });
});
