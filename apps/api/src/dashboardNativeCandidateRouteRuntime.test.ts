import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertDashboardDocument, type PublishedApplicationRecord } from "@bim-studio/contracts";
import { parseDeepRuntimePackage, serializeDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import source from "../../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json";
import { LocalObjectStore } from "./objects.js";
import { registerDashboardNativeCandidateRouteRuntime } from "./dashboardNativeCandidateRouteRuntime.js";
import type { DashboardWebStaticDownloadDependencies } from "./dashboardOfflineArchiveDownloadRoutes.js";
import { createApiServer } from "./serverOptions.js";
import { parseDashboardOfflineArchive } from "./dashboardOfflineArchiveBytes.js";

const authority = { projectId: "project-golden", applicationId: "dashboard-composition-golden",
  publicationId: "publication-1", applicationRevision: 1,
  entryPageId: "page.378d4cac696fa43e72c270f690e15329771ecf6ff6ac0b2cff9e4a2eca2dac15" } as const;
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

function published(): PublishedApplicationRecord {
  const document: unknown = structuredClone(source); assertDashboardDocument(document);
  document.application.metadata.id = authority.applicationId;
  document.application.metadata.projectId = authority.projectId;
  document.application.metadata.revision = authority.applicationRevision;
  document.application.pages[0]!.id = authority.entryPageId;
  document.application.publicationProfiles.forEach(profile => { profile.entryPageId = authority.entryPageId; });
  return { id: authority.publicationId, projectId: authority.projectId, applicationId: authority.applicationId,
    applicationRevision: authority.applicationRevision, document: document.application, publishedAt: "2026-09-16T12:00:00.000Z" };
}

async function fixture(portable = false, webStatic?: DashboardWebStaticDownloadDependencies) {
  const directory = await mkdtemp(path.join(tmpdir(), "dashboard-route-runtime-")); cleanup.push(directory);
  const objectKey = "projects/project-golden/assets/font.woff2", font = Uint8Array.of(1, 2, 3);
  const objectPath = path.join(directory, objectKey);
  await mkdir(path.dirname(objectPath), { recursive: true }); await writeFile(objectPath, font);
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
  const app = createApiServer();
  const nativeExecutable = path.join(directory, "test-only-player.exe");
  // PE 结构夹具，仅验证 HTTP 到打包器，不执行或声称真实窗口证据。
  const pe = Buffer.alloc(128); pe.writeUInt16LE(0x5a4d); pe.writeUInt32LE(64, 60); pe.writeUInt32LE(0x00004550, 64);
  if (portable) await writeFile(nativeExecutable, pe);
  app.addHook("preHandler", async request => { request.systemUser = { id: "editor", role: "editor", projectIds: [authority.projectId], enabled: true } as never; });
  const registered = await registerDashboardNativeCandidateRouteRuntime(app, { nativeExecutable: portable ? nativeExecutable : undefined,
    ...(portable ? { nativeExecutableSha256: sha(pe) } : {}), ...(webStatic === undefined ? {} : { webStatic }), runtime: { store, objects: new LocalObjectStore(directory), closure, compiler,
    expectedDeviceFingerprintSha256: "a".repeat(64), verifier: { verify: async input => ({ verifier: "native-dashboard-window-v1",
      authority, freezeManifestSha256: input.candidate.manifest.manifestSha256, sourceSemanticHash: input.sourceSemanticHash,
      compileGraphHash: input.compileGraphHash, targetArtifactHash: input.targetArtifactHash, fixtureSha256: "b".repeat(64),
      deviceFingerprintSha256: "a".repeat(64), fontSha256: [{ resourceId: "font", sha256: sha(font), faceIndex: 0 }],
      renderedNodeIds: ["widget-scene-main"] }) } } });
  return { app, registered, compiler, pe, artifact, nativeExecutable };
}

describe("dashboard Native candidate route runtime", () => {
  it("registers candidate generation and the private DMDA download only after all authoritative dependencies are supplied", async () => {
    const f = await fixture();
    expect(f.app.printRoutes()).toContain("dashboard-candidates");
    expect(f.app.printRoutes()).toContain("offline-archive");
    expect(f.app.printRoutes()).not.toContain("portable-zip");
    expect(f.registered.runtime.service.candidate).toBeUndefined();
    expect(f.compiler.compile).not.toHaveBeenCalled();
    await f.app.close();
  });

  it("prepares a candidate and downloads its same verified bytes through the real ZIP builder", async () => {
    const f = await fixture(true);
    const base = `/api/projects/${authority.projectId}/applications/${authority.applicationId}/dashboard-candidates`;
    try {
      const prepared = await f.app.inject({ method: "POST", url: base, payload: {
        publicationId: authority.publicationId, applicationRevision: authority.applicationRevision, entryPageId: authority.entryPageId,
      } });
      expect(prepared.statusCode, prepared.body).toBe(201);
      const candidate = prepared.json();
      const download = await f.app.inject({ method: "GET", url: `${base}/${candidate.candidateId}/portable-zip` });
      expect(download.statusCode, download.body).toBe(200);
      expect(download.headers["content-type"]).toBe("application/zip");
      const zip = await JSZip.loadAsync(download.rawPayload, { checkCRC32: true });
      expect(await zip.file("runtime-package.json")!.async("uint8array")).toEqual(f.artifact);
      expect(await zip.file("deep-native-player.exe")!.async("nodebuffer")).toEqual(f.pe);
      const manifest = JSON.parse(await zip.file("manifest.json")!.async("text"));
      expect(manifest.artifactSha256).toBe(candidate.artifactSha256);
      expect(manifest.authority.publicationId).toBe(authority.publicationId);
      const dmda = await f.app.inject({ method: "GET", url: `${base}/${candidate.candidateId}/offline-archive` });
      expect(dmda.statusCode).toBe(200);
      const parsed = parseDashboardOfflineArchive(dmda.rawPayload);
      expect(parsed.archive.artifact).toEqual(await zip.file("runtime-package.json")!.async("uint8array"));
      const changedExecutable = Buffer.from(f.pe); changedExecutable[100] ^= 1;
      await writeFile(f.nativeExecutable, changedExecutable);
      for (const endpoint of ["portable-zip", "standalone-executable"]) {
        const replaced = await f.app.inject({ method: "GET", url: `${base}/${candidate.candidateId}/${endpoint}` });
        expect(replaced.statusCode).toBe(409);
        expect(replaced.headers["content-disposition"]).toBeUndefined();
      }
      expect((await f.app.inject({ method: "GET", url: `${base}/${candidate.candidateId}/offline-archive` })).statusCode).toBe(200);
      f.registered.registry.remove(candidate.candidateId);
      expect((await f.app.inject({ method: "GET", url: `${base}/${candidate.candidateId}/portable-zip` })).statusCode).toBe(404);
    } finally { await f.app.close(); }
  });

  it("forwards the deployment webStatic supply so the web-package route exists only with it", async () => {
    const bare = await fixture();
    expect(bare.app.printRoutes()).toContain("offline-archive");
    expect(bare.app.printRoutes()).not.toContain("web-package");
    await bare.app.close();
    const webStatic = { readPublication: async () => undefined, readResourceObject: async () => new Uint8Array(),
      licensedFonts: [], webStaticRoot: path.join(tmpdir(), "dashboard-web-static-route") } as const;
    const configured = await fixture(false, webStatic);
    try {
      expect(configured.app.printRoutes()).toContain("web-package");
    } finally { await configured.app.close(); }
  });
});
