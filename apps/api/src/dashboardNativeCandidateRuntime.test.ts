import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertDashboardDocument, type PublishedApplicationRecord } from "@bim-studio/contracts";
import { parseDeepRuntimePackage, serializeDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import source from "../../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json";
import { LocalObjectStore } from "./objects.js";
import { createDashboardNativeCandidateRuntime } from "./dashboardNativeCandidateRuntime.js";

const authority = { projectId: "project-golden", applicationId: "application-worker-behavior",
  publicationId: "publication-1", applicationRevision: 1, entryPageId: "page-main" } as const;
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

function published(): PublishedApplicationRecord {
  const document: unknown = structuredClone(source); assertDashboardDocument(document);
  return { id: authority.publicationId, projectId: authority.projectId, applicationId: authority.applicationId,
    applicationRevision: authority.applicationRevision, document: document.application, publishedAt: "2026-09-16T12:00:00.000Z" };
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "dashboard-runtime-")); cleanup.push(directory);
  const objectKey = "projects/project-golden/assets/font.woff2", font = Uint8Array.of(1, 2, 3);
  const objectPath = path.join(directory, objectKey);
  await mkdir(path.dirname(objectPath), { recursive: true });
  await writeFile(objectPath, font);
  const raw = new Uint8Array(await readFile(new URL("../../../packages/deep-engine/fixtures/dashboard-composition-v1.json", import.meta.url)));
  const parsed = parseDeepRuntimePackage(raw); if (!parsed.valid) throw new Error("fixture package invalid");
  const artifact = new TextEncoder().encode(serializeDeepRuntimePackage(parsed.value));
  const publication = published();
  const store = {
    getProject: vi.fn(() => ({ id: authority.projectId })), getApplication: vi.fn(() => structuredClone(publication.document)),
    getApplicationPublicationPointer: vi.fn(() => ({ projectId: authority.projectId, activePublicationId: publication.id })),
    getPublishedApplication: vi.fn(() => structuredClone(publication)),
  };
  const closure = {
    derive: vi.fn(async () => ({ data: [], resources: [{ id: "font", kind: "font" as const, objectKey, mime: "font/woff2",
      nodeIds: ["widget-scene-main"], revision: 2, faceIndex: 0, license: { redistributable: true, evidence: "OFL" } }] })),
    resolveData: vi.fn(async () => ({ sourceRevision: "", value: null })), resourceRevision: vi.fn(async () => 2),
  };
  const compiler = { compilerId: "native-dashboard-v5", compilerVersion: "1.0.0", compilerSha256: "c".repeat(64),
    configuration: { runtimeSchema: 5 }, compile: vi.fn(async () => ({ artifact, objects: [{ nodeId: "widget-scene-main", contentCompiled: true, deferredFields: [] }] })) };
  const runtime = createDashboardNativeCandidateRuntime({ store, objects: new LocalObjectStore(directory), closure, compiler,
    expectedDeviceFingerprintSha256: "a".repeat(64), verifier: { verify: async input => ({ verifier: "native-dashboard-window-v1",
      authority, freezeManifestSha256: input.candidate.manifest.manifestSha256, sourceSemanticHash: input.sourceSemanticHash,
      compileGraphHash: input.compileGraphHash, targetArtifactHash: input.targetArtifactHash, fixtureSha256: "b".repeat(64),
      deviceFingerprintSha256: "a".repeat(64), fontSha256: [{ resourceId: "font", sha256: sha(font), faceIndex: 0 }],
      renderedNodeIds: ["widget-scene-main"] }) } });
  return { runtime, closure, compiler };
}

describe("dashboard Native candidate runtime composition", () => {
  it("uses the current published snapshot, trusted closure reader, object store and in-process authoritative compiler", async () => {
    const f = await fixture();
    const candidate = await f.runtime.service.prepare(authority);
    expect(candidate).toMatchObject({ authority, artifactSha256: sha(candidate.artifact.artifact), capability: { objects: [{ nodeId: "widget-scene-main", status: "supported" }] } });
    expect(f.closure.derive).toHaveBeenCalledWith(expect.objectContaining({ id: authority.publicationId }), authority.entryPageId, expect.any(AbortSignal));
    expect(f.closure.resourceRevision).toHaveBeenCalledWith(authority, expect.objectContaining({ objectKey: "projects/project-golden/assets/font.woff2" }), expect.any(AbortSignal));
    expect(f.compiler.compile).toHaveBeenCalledTimes(2);
  });

  it("fails closed when trusted resource metadata no longer has the frozen revision", async () => {
    const f = await fixture();
    f.closure.resourceRevision.mockResolvedValueOnce(3);
    await expect(f.runtime.service.prepare(authority)).rejects.toMatchObject({ name: "DashboardPublicationStaleError" });
    expect(f.compiler.compile).not.toHaveBeenCalled();
  });
});
