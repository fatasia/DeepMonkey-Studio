import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { assertDashboardDocument, type PublishedApplicationRecord } from "@bim-studio/contracts";
import { parseDeepRuntimePackage, serializeDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import source from "../../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json";
import {
  createDashboardPublicationAuthorityAdapter,
  type DashboardPublicationTrustedInputs,
} from "./dashboardPublicationAuthorityAdapter.js";
import {
  createDashboardNativeCandidateService,
  DashboardNativeCandidateSupersededError,
} from "./dashboardNativeCandidateService.js";

const request = { projectId: "project-golden", applicationId: "application-worker-behavior",
  publicationId: "publication-1", applicationRevision: 1, entryPageId: "page-main" } as const;
const compilerIdentity = { id: "native-dashboard-v5", version: "1.0.0", sha256: "c".repeat(64),
  configuration: { antialias: "msaa4", runtimeSchema: 5 } } as const;
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

function publication(): PublishedApplicationRecord {
  const value: unknown = structuredClone(source); assertDashboardDocument(value);
  return { id: request.publicationId, projectId: request.projectId, applicationId: request.applicationId,
    applicationRevision: request.applicationRevision, document: value.application, publishedAt: "2026-09-16T12:00:00.000Z" };
}

async function artifact(): Promise<Uint8Array> {
  const bytes = new Uint8Array(await readFile(new URL("../../../packages/deep-engine/fixtures/dashboard-composition-v1.json", import.meta.url)));
  const parsed = parseDeepRuntimePackage(bytes);
  if (!parsed.valid) throw new Error("Test package fixture invalid");
  return new TextEncoder().encode(serializeDeepRuntimePackage(parsed.value));
}

async function fixture(options: { readonly changeAfterWorker?: boolean; readonly deferWorker?: boolean } = {}) {
  let active = publication(), revision = 1;
  const bytes = await artifact();
  const store = {
    getProject: vi.fn(() => ({ id: request.projectId })),
    getApplication: vi.fn(() => ({ ...active.document, metadata: { ...active.document.metadata, revision } })),
    getApplicationPublicationPointer: vi.fn(() => ({ projectId: request.projectId, activePublicationId: active.id })),
    getPublishedApplication: vi.fn(() => structuredClone(active)),
  };
  const trustedInputs: DashboardPublicationTrustedInputs = {
    derive: vi.fn(async () => ({ data: [], resources: [{ id: "font", kind: "font", objectKey: "projects/project-golden/assets/font.woff2",
      mime: "font/woff2", nodeIds: ["widget-scene-main"], revision: 2, faceIndex: 0, license: { redistributable: true, evidence: "OFL" } }] })),
    resolveData: vi.fn(async () => ({ sourceRevision: "", value: null })),
    readResource: vi.fn(async () => ({ revision: 2, bytes: new Uint8Array([1, 2, 3]) })),
  };
  const authority = createDashboardPublicationAuthorityAdapter({ store, trustedInputs });
  let releaseWorker: (() => void) | undefined, workerRuns = 0;
  const worker = { compile: vi.fn(async (input: Parameters<typeof makeOutput>[0]) => {
    if (options.deferWorker && ++workerRuns === 1) await new Promise<void>(resolve => { releaseWorker = resolve; });
    if (options.changeAfterWorker) revision = 2;
    return makeOutput(input, bytes);
  }) };
  const service = createDashboardNativeCandidateService({ authority, compiler: {
    compilerId: compilerIdentity.id, compilerVersion: compilerIdentity.version, compilerSha256: compilerIdentity.sha256,
    configuration: compilerIdentity.configuration,
    compile: async () => ({ artifact: bytes, objects: [{ nodeId: "widget-scene-main", contentCompiled: true, deferredFields: [] }] }),
  }, compilerIdentity, expectedDeviceFingerprintSha256: "a".repeat(64), worker,
  verifyWindow: async input => ({ verifier: "native-dashboard-window-v1", authority: request,
    freezeManifestSha256: input.candidate.manifest.manifestSha256, sourceSemanticHash: input.sourceSemanticHash,
    compileGraphHash: input.compileGraphHash, targetArtifactHash: input.targetArtifactHash,
    fixtureSha256: "b".repeat(64), deviceFingerprintSha256: "a".repeat(64),
    fontSha256: [{ resourceId: "font", sha256: sha(new Uint8Array([1, 2, 3])), faceIndex: 0 }], renderedNodeIds: ["widget-scene-main"] }),
  });
  return { service, worker, trustedInputs, releaseWorker: () => releaseWorker?.() };
}

function makeOutput(input: { readonly protocol: "dashboard-runtime-compiler-v1"; readonly authority: typeof request;
  readonly freezeManifestSha256: string; readonly sourceSemanticHash: string; readonly compileGraphHash: string }, bytes: Uint8Array) {
  return { protocol: input.protocol, authority: input.authority, freezeManifestSha256: input.freezeManifestSha256,
    sourceSemanticHash: input.sourceSemanticHash, compileGraphHash: input.compileGraphHash, artifact: bytes } as const;
}

describe("dashboard Native candidate service", () => {
  it("keeps only a fully authority, hash, and window-bound candidate in memory", async () => {
    const f = await fixture();
    const candidate = await f.service.prepare(request);
    expect(candidate).toMatchObject({ authority: request, artifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      targetArtifactHash: candidate.artifactSha256, windowVerification: { verifier: "native-dashboard-window-v1" },
      capability: { freezeManifestSha256: candidate.freezeManifestSha256 } });
    expect(f.service.candidate).toEqual(candidate);
    f.service.clear();
    expect(f.service.candidate).toBeUndefined();
  });

  it("fails closed after a stale revision appears in the worker window without retaining a candidate", async () => {
    const f = await fixture({ changeAfterWorker: true });
    await expect(f.service.prepare(request)).rejects.toMatchObject({ name: "DashboardPublicationStaleError" });
    expect(f.service.candidate).toBeUndefined();
    expect(f.worker.compile).toHaveBeenCalledTimes(1);
  });

  it("cancels an older candidate before it becomes observable", async () => {
    const f = await fixture({ deferWorker: true });
    const first = f.service.prepare(request);
    await vi.waitFor(() => expect(f.worker.compile).toHaveBeenCalledTimes(1));
    const second = f.service.prepare(request);
    f.releaseWorker();
    await expect(first).rejects.toSatisfy((error: unknown) => error instanceof DOMException || error instanceof DashboardNativeCandidateSupersededError);
    await expect(second).resolves.toMatchObject({ authority: request });
  });
});
