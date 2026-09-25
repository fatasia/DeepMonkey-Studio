import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";
import { summarizeScenePublicationCompatibility, type PublicationCapabilityEvidence } from "@bim-studio/contracts";
import { createSceneStandaloneExecutable, type SceneExecutableDependencies } from "./sceneStandaloneExecutable.js";
import { registerSceneStandaloneExecutableRoutes } from "./sceneStandaloneExecutableRoutes.js";
import { createApiServer } from "./serverOptions.js";

const mocks = vi.hoisted(() => ({ embed: vi.fn() }));
vi.mock("./nativeStandaloneExecutable.js", () => ({ embedVerifiedNativeArtifact: mocks.embed }));
beforeEach(() => { vi.clearAllMocks(); mocks.embed.mockResolvedValue(Buffer.from("MZ-packaged")); });

// Structural authority fixture only; actual GPU/EXE evidence is in the acceptance script.
function fixture() {
  const artifact = Buffer.from("{}"), digest = createHash("sha256").update(artifact).digest("hex"), at = "2026-09-18T00:00:00Z";
  const executable = Buffer.alloc(128); executable.write("MZ", 0, "ascii"); executable.writeUInt32LE(64, 0x3c); executable.write("PE\0\0", 64, "ascii");
  const executableSha256 = createHash("sha256").update(executable).digest("hex");
  const capabilities = ["deep.scene.runtime.v1", "deep.scene.camera.v1"];
  const evidence: PublicationCapabilityEvidence[] = capabilities.map(capability => ({ id: capability, capability,
    target: "deep-native", sourceSemanticHash: digest, compileGraphHash: digest, targetArtifactHash: digest,
    scope: "native-window", fixtureId: `scene-${digest}`, platform: "windows-x64" }));
  const report = summarizeScenePublicationCompatibility({ target: "deep-native", sceneId: "s", contentFingerprint: digest,
    compileGraphHash: digest, targetArtifactHash: digest, fixtureId: `scene-${digest}`, platform: "windows-x64",
    profile: { version: "deep-scene-compiled-v1", capabilities }, evidence,
    items: capabilities.map((capability, index) => ({ sceneId: "s", objectId: "s", path: index ? "camera" : "$",
      capability, status: "supported", reason: "test", remediation: "reverify", evidenceIds: [capability] })) });
  const snapshot = { schemaVersion: 1, projectId: "p", id: "s", name: "s", models: [], primitives: [], measurements: [],
    camera: { mode: "orbit", position: { x: 0, y: 1, z: 2 }, target: { x: 0, y: 0, z: 0 } }, createdAt: at, updatedAt: at };
  const publication = { projectId: "p", sceneId: "s", version: 1, publishedAt: at, snapshot };
  const executableKey = `projects/p/publication-resources/sha256/${executableSha256}`;
  const record = { schemaVersion: 1, projectId: "p", sceneId: "s", version: 1, publishedAt: at, publicationIdentity: "test",
    inputs: { project: { id: "p", name: "p", description: "", models: [] }, applications: [],
      runtime: { connections: [], datasets: [], pipelines: [] }, resources: [] }, resources: [],
    nativeCompiled: { runtimePackage: { key: `projects/p/publication-resources/sha256/${digest}`, bytes: artifact.length, sha256: digest },
      executable: { key: executableKey, bytes: executable.length, sha256: executableSha256 },
      compilationEvidence: { sourceSemanticHash: digest, compileGraphHash: digest, targetArtifactHash: digest },
      compatibilityReport: report, compilerSha256: digest, executableSha256, verifiedAt: at } };
  const store = { getScenePublicationDependencies: vi.fn(() => record), listScenePublications: vi.fn(() => [publication]) };
  const objects = { read: vi.fn(async (key: string) => ({ stream: Readable.from([key === executableKey ? executable : artifact]), completed: Promise.resolve() })) };
  const assess = vi.fn(async () => report), controller = new AbortController();
  const deps = { store, objects, assess, nativeExecutable: "C:/verified.exe" } as unknown as SceneExecutableDependencies;
  const input = { projectId: "p", sceneId: "s", version: 1, signal: controller.signal };
  return { artifact, digest, executable, executableSha256, record, store, objects, assess, controller, deps, input };
}

it("uses exact frozen bytes and original verified EXE SHA, with a final authority recheck", async () => {
  const f = fixture(); const result = await createSceneStandaloneExecutable(f.deps, f.input);
  expect(result.artifactSha256).toBe(f.digest);
  expect(mocks.embed).toHaveBeenCalledWith(f.artifact, f.executable, { signal: f.controller.signal, expectedSha256: f.executableSha256 });
  expect(f.store.getScenePublicationDependencies).toHaveBeenCalledTimes(2);
});
it("keeps legacy publications on the verified deployment path", async () => {
  const f = fixture(); delete f.record.nativeCompiled.executable;
  await createSceneStandaloneExecutable(f.deps, f.input);
  expect(mocks.embed).toHaveBeenCalledWith(f.artifact, "C:/verified.exe", { signal: f.controller.signal, expectedSha256: f.executableSha256 });
});
it("downloads a frozen publication without a live deployment executable", async () => {
  const f = fixture(); delete f.deps.nativeExecutable;
  await createSceneStandaloneExecutable(f.deps, f.input);
  expect(mocks.embed).toHaveBeenCalledWith(f.artifact, f.executable, { signal: f.controller.signal, expectedSha256: f.executableSha256 });
});
it("rejects legacy publications when no compatible deployment executable remains", async () => {
  const f = fixture(); delete f.record.nativeCompiled.executable; delete f.deps.nativeExecutable;
  await expect(createSceneStandaloneExecutable(f.deps, f.input)).rejects.toThrow("旧发布版本没有冻结 Native 程序");
});
it.each(["path", "size", "hash", "executable-path", "executable-size", "executable-hash", "foreign", "missing-version", "not-ready"])("rejects %s before packaging", async kind => {
  const f = fixture();
  if (kind === "path") f.record.nativeCompiled.runtimePackage.key = "projects/foreign/resource";
  if (kind === "size") f.record.nativeCompiled.runtimePackage.bytes = 1;
  if (kind === "hash") f.objects.read.mockResolvedValue({ stream: Readable.from([Buffer.from("xx")]), completed: Promise.resolve() });
  if (kind === "executable-path") f.record.nativeCompiled.executable.key = "projects/foreign/resource";
  if (kind === "executable-size") f.record.nativeCompiled.executable.bytes = 1;
  if (kind === "executable-hash") f.objects.read.mockImplementation(async (key: string) => ({ stream: Readable.from([key === f.record.nativeCompiled.executable.key ? Buffer.from("xx") : f.artifact]), completed: Promise.resolve() }));
  if (kind === "foreign") f.record.projectId = "foreign";
  if (kind === "missing-version") f.store.listScenePublications.mockReturnValue([]);
  if (kind === "not-ready") f.assess.mockResolvedValue({ ...f.record.nativeCompiled.compatibilityReport, status: "blocked" });
  await expect(createSceneStandaloneExecutable(f.deps, f.input)).rejects.toThrow(); expect(mocks.embed).not.toHaveBeenCalled();
});
it("rejects live-reference metadata mutation during packaging", async () => {
  const f = fixture(); mocks.embed.mockImplementation(async () => { f.record.nativeCompiled.verifiedAt = "2026-09-19T00:00:00Z"; return Buffer.from("MZ"); });
  await expect(createSceneStandaloneExecutable(f.deps, f.input)).rejects.toThrow("打包期间变化");
});
it("cancels while completed is pending after stream end", async () => {
  const f = fixture(); f.objects.read.mockResolvedValue({ stream: Readable.from([f.artifact]), completed: new Promise(() => {}) });
  const result = createSceneStandaloneExecutable(f.deps, f.input);
  await vi.waitFor(() => expect(f.objects.read).toHaveBeenCalledOnce()); f.controller.abort(new Error("cancelled"));
  await expect(result).rejects.toThrow("cancelled"); expect(mocks.embed).not.toHaveBeenCalled();
});
it("rejects changed executable identity instead of substituting an unverified binary", async () => {
  const f = fixture(); mocks.embed.mockRejectedValue(new Error("Native executable changed since deployment"));
  await expect(createSceneStandaloneExecutable(f.deps, f.input)).rejects.toThrow("重新验证并发布");
});
it.each(["anonymous", "disabled", "viewer", "foreign-project", "invalid-brand", "unknown-body", "invalid-version"])("route rejects %s without reading frozen resources", async kind => {
  const f = fixture(), app = createApiServer();
  app.addHook("preHandler", async request => {
    if (kind !== "anonymous") request.systemUser = { id: "u", enabled: kind !== "disabled", role: kind === "viewer" ? "viewer" : "editor",
      projectIds: kind === "foreign-project" ? [] : ["p"] } as never;
  });
  try {
    await registerSceneStandaloneExecutableRoutes(app, f.deps);
    const result = await app.inject({ method: "POST", url: `/api/projects/p/scenes/s/publications/${kind === "invalid-version" ? "0" : "1"}/native-executable`,
      payload: kind === "invalid-brand" ? { branding: { applicationName: "x\u0000y" } } : kind === "unknown-body" ? { executable: "arbitrary.exe" } : {} });
    expect(result.statusCode).toBeGreaterThanOrEqual(400); expect(f.objects.read).not.toHaveBeenCalled();
  } finally { await app.close(); }
});
it("route sends private EXE and RFC5987 filename for an authorized editor", async () => {
  const f = fixture(), app = createApiServer();
  app.addHook("preHandler", async request => { request.systemUser = { id: "u", enabled: true, role: "editor", projectIds: ["p"] } as never; });
  try {
    await registerSceneStandaloneExecutableRoutes(app, f.deps);
    const result = await app.inject({ method: "POST", url: "/api/projects/p/scenes/s/publications/1/native-executable", payload: { branding: { applicationName: "客户's" } } });
    expect(result.statusCode).toBe(200); expect(result.headers["cache-control"]).toBe("private, no-store");
    expect(result.headers["content-disposition"]).toContain("%27");
  } finally { await app.close(); }
});
