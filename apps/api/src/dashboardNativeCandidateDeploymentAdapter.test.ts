import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertDashboardDocument, type PublishedApplicationRecord } from "@bim-studio/contracts";
import { parseDeepRuntimePackage, serializeDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import source from "../../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json";
import { createDashboardNativeCandidateDeploymentAdapter, DashboardNativeCandidateDeploymentUnavailableError } from "./dashboardNativeCandidateDeploymentAdapter.js";
import { LocalObjectStore } from "./objects.js";

const authority = { projectId: "project-golden", applicationId: "dashboard-deployment", publicationId: "publication-1",
  applicationRevision: 1, entryPageId: "page-main" } as const;
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

function published(): PublishedApplicationRecord {
  const document: unknown = structuredClone(source); assertDashboardDocument(document);
  document.application.metadata.id = authority.applicationId;
  document.application.metadata.projectId = authority.projectId;
  document.application.metadata.revision = authority.applicationRevision;
  document.application.pages[0]!.id = authority.entryPageId;
  return { id: authority.publicationId, projectId: authority.projectId, applicationId: authority.applicationId,
    applicationRevision: authority.applicationRevision, document: document.application, publishedAt: "2026-09-16T12:00:00.000Z" };
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "dashboard-deployment-")); cleanup.push(directory);
  const objectKey = "projects/project-golden/assets/font.woff2", font = Uint8Array.of(1, 2, 3);
  const objectPath = path.join(directory, objectKey); await mkdir(path.dirname(objectPath), { recursive: true }); await writeFile(objectPath, font);
  const raw = new Uint8Array(await readFile(new URL("../../../packages/deep-engine/fixtures/dashboard-composition-v1.json", import.meta.url)));
  const parsed = parseDeepRuntimePackage(raw); if (!parsed.valid) throw new Error("fixture package invalid");
  const artifact = new TextEncoder().encode(serializeDeepRuntimePackage(parsed.value));
  const publication = published();
  const store = { getProject: vi.fn(() => ({ id: authority.projectId })), getApplication: vi.fn(() => structuredClone(publication.document)),
    getApplicationPublicationPointer: vi.fn(() => ({ projectId: authority.projectId, activePublicationId: publication.id })),
    getPublishedApplication: vi.fn(() => structuredClone(publication)) };
  const compiler = { compilerId: "native-dashboard-v5", compilerVersion: "1.0.0", compilerSha256: "c".repeat(64), configuration: { runtimeSchema: 5 },
    compile: vi.fn(async () => ({ artifact, objects: [{ nodeId: "widget-scene-main", contentCompiled: true, deferredFields: [] }] })) };
  const closure = { derive: vi.fn(async () => ({ data: [], resources: [{ id: "font", kind: "font" as const, objectKey, mime: "font/woff2",
    nodeIds: ["widget-scene-main"], revision: 2, faceIndex: 0, license: { redistributable: true, evidence: "OFL" } }] })),
    resolveData: vi.fn(async () => ({ sourceRevision: "", value: null })), resourceRevision: vi.fn(async () => 2) };
  const verifier = { verify: vi.fn(async input => ({ verifier: "native-dashboard-window-v1", authority,
    freezeManifestSha256: input.candidate.manifest.manifestSha256, sourceSemanticHash: input.sourceSemanticHash,
    compileGraphHash: input.compileGraphHash, targetArtifactHash: input.targetArtifactHash, fixtureSha256: "b".repeat(64),
    deviceFingerprintSha256: "a".repeat(64), fontSha256: [{ resourceId: "font", sha256: sha(font), faceIndex: 0 }], renderedNodeIds: ["widget-scene-main"] })) };
  return { store, objects: new LocalObjectStore(directory), compiler, closure, verifier };
}

describe("Dashboard Native deployment adapter", () => {
  it("fails closed until deployment supplies every Dashboard-specific authority source", async () => {
    const f = await fixture();
    expect(() => createDashboardNativeCandidateDeploymentAdapter({ store: f.store, objects: f.objects, bindings: {} }))
      .toThrow(DashboardNativeCandidateDeploymentUnavailableError);
    expect(f.compiler.compile).not.toHaveBeenCalled();
  });

  it("composes published authority, object bytes, compiler identity and window verifier into one candidate", async () => {
    const f = await fixture();
    const runtime = createDashboardNativeCandidateDeploymentAdapter({ store: f.store, objects: f.objects, bindings: {
      closure: f.closure, compiler: f.compiler, expectedDeviceFingerprintSha256: "a".repeat(64), verifier: f.verifier,
    } });
    const candidate = await runtime.service.prepare(authority);
    expect(candidate).toMatchObject({ authority, artifactSha256: sha(candidate.artifact.artifact),
      capability: { compiler: { id: "native-dashboard-v5", sha256: "c".repeat(64) }, objects: [
        { nodeId: "widget-scene-main", status: "supported" }, { nodeId: "second", status: "blocked", deferredFields: ["$"] },
      ] } });
    expect(f.closure.derive).toHaveBeenCalledOnce();
    expect(f.verifier.verify).toHaveBeenCalledOnce();
    expect(f.compiler.compile).toHaveBeenCalledTimes(2);
  });
});
