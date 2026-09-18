import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { sceneCompilationSource } from "./sceneCompilationSource";
import { afterEach, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { createHash } from "node:crypto";
import type { PublishedSceneRecord, ScenePublicationDependencies, SceneSnapshot } from "@bim-studio/contracts";
import { compileSceneRuntimePackage } from "./compileSceneRuntimePackage";
import { assessCompiledScenePublication } from "./scenePublicationCompatibility";
import { scenePublicationDependencyIdentity } from "./sceneClientFrozenDependencies";
import { prepareFrozenNativeScenePayload } from "./sceneNativeFrozenPayload";
import { exportSceneClientPackage } from "./sceneClientPackage";

const mocks = vi.hoisted(() => ({ bytes: vi.fn(), record: vi.fn(), project: vi.fn(), applications: vi.fn(), compile: vi.fn(), download: vi.fn() }));
vi.mock("../api", () => ({ api: { loadScenePublicationResource: mocks.bytes, getScenePublicationDependencies: mocks.record,
  getProject: mocks.project, listApplications: mocks.applications } }));
vi.mock("./nativeSceneClientPayload", () => ({ prepareNativeSceneClientPayload: mocks.compile }));
vi.mock("../browserDownload", () => ({ downloadBlob: mocks.download }));
afterEach(() => vi.resetAllMocks());

async function fixture() {
  const at = "2026-09-15T12:00:00Z";
  const scene: SceneSnapshot = { schemaVersion: 1, id: "s", projectId: "p", name: "Frozen", models: [], primitives: [], measurements: [],
    camera: { mode: "orbit", position: { x: 1e9 + 1, y: 1e9 + 2, z: 1e9 + 3 }, target: { x: 1e9, y: 1e9, z: 1e9 } },
    createdAt: at, updatedAt: at, publishedAt: at };
  const publication: PublishedSceneRecord = { projectId: "p", sceneId: "s", version: 1, name: scene.name, publishedAt: at, snapshot: scene };
  const compiled = await compileSceneRuntimePackage(scene, { packageId: "server.package", packageVersion: "1.0.0", loadModel: vi.fn() });
  const evidence = compiled.evidence, fixtureId = `scene-${evidence.sourceSemanticHash}`;
  // 仅用于校验历史导出路径的测试证据，不能作为正式窗口验证记录。
  const runtimeEvidence = ["deep.scene.runtime.v1", "deep.scene.camera.v1"].map(capability => ({ id: capability, capability,
    target: "deep-native" as const, scope: "native-window" as const, platform: "windows-x64", fixtureId,
    sourceSemanticHash: evidence.sourceSemanticHash, compileGraphHash: evidence.compileGraphHash, targetArtifactHash: evidence.targetArtifactHash }));
  const compatibilityReport = assessCompiledScenePublication(scene, { compilation: evidence, fixtureId, platform: "windows-x64", runtimeEvidence });
  expect(compatibilityReport.status).toBe("ready");
  const content = new TextEncoder().encode(compiled.packageJson).buffer;
  const record: ScenePublicationDependencies = { schemaVersion: 1, projectId: "p", sceneId: "s", version: 1, publishedAt: at,
    publicationIdentity: await scenePublicationDependencyIdentity(publication), resources: [],
    inputs: { project: { id: "p", name: "P", description: "", models: [], assets: [] }, applications: [],
      runtime: { connections: [], datasets: [], pipelines: [] }, resources: [] },
    nativeCompiled: { runtimePackage: { key: `projects/p/publication-resources/sha256/${evidence.targetArtifactHash}`, bytes: content.byteLength, sha256: evidence.targetArtifactHash },
      compilationEvidence: { ...evidence }, compatibilityReport, compilerSha256: "d".repeat(64), executableSha256: "e".repeat(64), verifiedAt: at } };
  mocks.record.mockResolvedValue(record); mocks.bytes.mockResolvedValue(content);
  return { scene, publication, compiled, record, content };
}

it("exports the exact server runtime bytes through a real ZIP without browser compilation or live project reads", async () => {
  const { scene, publication, compiled, record } = await fixture();
  await exportSceneClientPackage({ projectId: "p", scene, publication, target: "deep-native", renderer: "webgl", toolbarVisible: true });
  expect(mocks.bytes).toHaveBeenCalledExactlyOnceWith(`/api/projects/p/scenes/s/publications/1/dependencies/resources/${record.nativeCompiled!.runtimePackage.sha256}`,
    record.nativeCompiled!.runtimePackage.bytes, expect.any(AbortSignal));
  expect(mocks.compile).not.toHaveBeenCalled(); expect(mocks.project).not.toHaveBeenCalled(); expect(mocks.applications).not.toHaveBeenCalled();
  const zip = await JSZip.loadAsync(await (mocks.download.mock.calls[0]![0] as Blob).arrayBuffer());
  expect(await zip.file("native/runtime-package.json")!.async("string")).toBe(compiled.packageJson);
  expect(JSON.parse(await zip.file("native/compatibility-report.json")!.async("string")).status).toBe("ready");
});

it.each(["bytes", "inner-package", "graph-binding", "source", "graph", "proof", "foreign-key", "missing"])("rejects corrupted frozen Native %s", async kind => {
  const { scene, record, content } = await fixture();
  if (kind === "bytes") { const altered = content.slice(0); new Uint8Array(altered)[0] = 0; mocks.bytes.mockResolvedValue(altered); }
  if (kind === "inner-package") {
    const value = JSON.parse(new TextDecoder().decode(content)); value.packageVersion = "9.9.9";
    const altered = new TextEncoder().encode(JSON.stringify(value)).buffer, hash = createHash("sha256").update(new Uint8Array(altered)).digest("hex");
    const native = record.nativeCompiled!;
    native.runtimePackage = { bytes: altered.byteLength, sha256: hash, key: `projects/p/publication-resources/sha256/${hash}` };
    native.compilationEvidence.targetArtifactHash = hash;
    Object.assign(native.compatibilityReport, { targetArtifactHash: hash, evidence: native.compatibilityReport.evidence.map(proof => ({ ...proof, targetArtifactHash: hash })) });
    mocks.bytes.mockResolvedValue(altered);
  }
  if (kind === "graph-binding") {
    const native = record.nativeCompiled!, hash = "f".repeat(64); native.compilationEvidence.compileGraphHash = hash;
    Object.assign(native.compatibilityReport, { compileGraphHash: hash, evidence: native.compatibilityReport.evidence.map(proof => ({ ...proof, compileGraphHash: hash })) });
  }
  if (kind === "source") scene.camera.position.x += 1;
  if (kind === "graph") record.nativeCompiled!.compilationEvidence.compileGraphHash = "f".repeat(64);
  if (kind === "proof") Object.assign(record.nativeCompiled!.compatibilityReport, { evidence: [] });
  if (kind === "foreign-key") record.nativeCompiled!.runtimePackage.key = "projects/other/private";
  if (kind === "missing") delete record.nativeCompiled;
  await expect(prepareFrozenNativeScenePayload(scene, record, new AbortController().signal)).rejects.toThrow();
  expect(mocks.compile).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  if (["foreign-key", "missing", "graph"].includes(kind)) expect(mocks.bytes).not.toHaveBeenCalled();
});

it("does not read or export after cancellation", async () => {
  const { scene, record } = await fixture(), controller = new AbortController(); controller.abort();
  await expect(prepareFrozenNativeScenePayload(scene, record, controller.signal)).rejects.toThrow();
  expect(mocks.bytes).not.toHaveBeenCalled();
});

it("rejects an uncompiled weather field after all source evidence is rebound", async () => {
  const { scene, record, compiled } = await fixture();
  scene.weather = "sunny";
  const native = record.nativeCompiled!, evidence = native.compilationEvidence;
  evidence.sourceSemanticHash = runtimeContentSha256(sceneCompilationSource(scene));
  const runtime = compiled.runtimePackage;
  evidence.compileGraphHash = runtimeContentSha256({ recipe: evidence.recipe, sourceSemanticHash: evidence.sourceSemanticHash,
    sourceAssets: evidence.sourceAssets, packageId: runtime.packageId, packageVersion: runtime.packageVersion,
    maxSourceBytes: evidence.maxSourceBytes, localCoordinates: evidence.localCoordinates,
    cameraHash: runtime.resources.find(resource => resource.kind === "scene-camera")!.contentHash.value,
    renderPacketHash: runtime.resources.find(resource => resource.kind === "render-packet")!.contentHash.value });
  const fixtureId = `scene-${evidence.sourceSemanticHash}`;
  Object.assign(native.compatibilityReport, { fixtureId, contentFingerprint: evidence.sourceSemanticHash,
    compileGraphHash: evidence.compileGraphHash, evidence: native.compatibilityReport.evidence.map(proof => ({ ...proof,
      fixtureId, sourceSemanticHash: evidence.sourceSemanticHash, compileGraphHash: evidence.compileGraphHash })) });
  await expect(prepareFrozenNativeScenePayload(scene, record, new AbortController().signal)).rejects.toThrow();
});
