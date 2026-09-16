import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertDashboardDocument, type PublishedApplicationRecord } from "@bim-studio/contracts";
import source from "../../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json";
import { prepareDashboardPublicationFreeze, type DashboardFrozenResourceRequest } from "./dashboardPublicationFreeze.js";
import { buildDashboardPublicationCapabilityReport, type DashboardWindowVerification } from "./dashboardPublicationCapability.js";

const authority = { projectId: "project-golden", applicationId: "application-worker-behavior", publicationId: "publication-1", applicationRevision: 1 } as const;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const device = "a".repeat(64);

function state() {
  const value: unknown = structuredClone(source); assertDashboardDocument(value);
  const publication: PublishedApplicationRecord = { id: authority.publicationId, projectId: authority.projectId,
    applicationId: authority.applicationId, applicationRevision: authority.applicationRevision, document: value.application,
    publishedAt: "2026-09-16T12:00:00.000Z" };
  return { activePublicationId: authority.publicationId, currentApplicationRevision: 1, publication };
}
function font(): DashboardFrozenResourceRequest { return { id: "font", kind: "font", objectKey: "projects/project-golden/assets/font.woff2",
  mime: "font/woff2", nodeIds: ["widget-scene-main"], revision: 2, faceIndex: 0, license: { redistributable: true, evidence: "OFL" } }; }
async function candidate(fontBytes = new Uint8Array([1, 2, 3])) {
  return prepareDashboardPublicationFreeze({ expected: authority, entryPageId: "page-main", data: [], resources: [font()],
    readAuthority: async () => state(), resolveData: async () => ({ sourceRevision: "", value: null }),
    readResource: async () => ({ revision: 2, bytes: fontBytes }) });
}
function inputs(frozen: Awaited<ReturnType<typeof candidate>>, patch: Partial<DashboardWindowVerification> = {}) {
  const artifact = new Uint8Array([9, 8, 7]);
  return { candidate: frozen, expectedDeviceFingerprintSha256: device,
    revalidation: { readAuthority: async () => state(), resolveData: async () => ({ sourceRevision: "", value: null }),
      readResource: async () => ({ revision: 2, bytes: new Uint8Array([1, 2, 3]) }) },
    compiler: { compilerId: "native-dashboard", compilerVersion: "1", compilerSha256: "c".repeat(64), configuration: { antialias: "msaa4" },
      compile: async () => ({ artifact, objects: [{ nodeId: "widget-scene-main", contentCompiled: true, deferredFields: [] },
        { nodeId: "deferred", contentCompiled: false, deferredFields: ["widget.video"] }] }) },
    verifyWindow: async (request: { sourceSemanticHash: string; compileGraphHash: string; targetArtifactHash: string }) => ({
      verifier: "native-dashboard-window-v1", authority, freezeManifestSha256: frozen.manifest.manifestSha256,
      sourceSemanticHash: request.sourceSemanticHash, compileGraphHash: request.compileGraphHash, targetArtifactHash: request.targetArtifactHash,
      fixtureSha256: "b".repeat(64), deviceFingerprintSha256: device,
      fontSha256: [{ resourceId: "font", sha256: sha(new Uint8Array([1, 2, 3])), faceIndex: 0 }], renderedNodeIds: ["widget-scene-main"], ...patch }),
  } as const;
}

describe("dashboard publication capability report", () => {
  it("binds the three hashes to frozen authority, actual target bytes, device and font closure", async () => {
    const frozen = await candidate(), report = await buildDashboardPublicationCapabilityReport(inputs(frozen));
    expect(report).toMatchObject({ authority, freezeManifestSha256: frozen.manifest.manifestSha256,
      targetArtifactHash: sha(new Uint8Array([9, 8, 7])), objects: [{ nodeId: "widget-scene-main", status: "supported" },
        { nodeId: "deferred", status: "blocked" }] });
    expect(report.sourceSemanticHash).toMatch(/^[a-f0-9]{64}$/); expect(report.compileGraphHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes source evidence when frozen font bytes change", async () => {
    const one = await candidate(), two = await candidate(new Uint8Array([1, 2, 4]));
    // The second candidate needs matching authoritative resource reads, not a browser claim.
    const second = inputs(two);
    const original = second.revalidation.readResource;
    Object.assign(second.revalidation, { readResource: async () => ({ revision: 2, bytes: new Uint8Array([1, 2, 4]) }) });
    Object.assign(second, { verifyWindow: async request => ({ verifier: "native-dashboard-window-v1", authority,
      freezeManifestSha256: two.manifest.manifestSha256, sourceSemanticHash: request.sourceSemanticHash,
      compileGraphHash: request.compileGraphHash, targetArtifactHash: request.targetArtifactHash, fixtureSha256: "b".repeat(64),
      deviceFingerprintSha256: device, fontSha256: [{ resourceId: "font", sha256: sha(new Uint8Array([1, 2, 4])), faceIndex: 0 }],
      renderedNodeIds: ["widget-scene-main"] }) });
    expect((await buildDashboardPublicationCapabilityReport(inputs(one))).sourceSemanticHash)
      .not.toBe((await buildDashboardPublicationCapabilityReport(second)).sourceSemanticHash);
    void original;
  });

  it.each([
    ["revision", { authority: { ...authority, applicationRevision: 2 } }],
    ["device", { deviceFingerprintSha256: "c".repeat(64) }],
    ["font", { fontSha256: [{ resourceId: "font", sha256: "d".repeat(64), faceIndex: 0 }] }],
  ])("rejects %s evidence substitution", async (_name, patch) => {
    const frozen = await candidate();
    await expect(buildDashboardPublicationCapabilityReport(inputs(frozen, patch))).rejects.toThrow(/not bound|font evidence/);
  });

  it("does not elevate a compiler or client-like claim without verifier-rendered coverage", async () => {
    const frozen = await candidate(), input = inputs(frozen);
    Object.assign(input, { verifyWindow: async request => ({ verifier: "native-dashboard-window-v1", authority,
      freezeManifestSha256: frozen.manifest.manifestSha256, sourceSemanticHash: request.sourceSemanticHash,
      compileGraphHash: request.compileGraphHash, targetArtifactHash: request.targetArtifactHash, fixtureSha256: "b".repeat(64),
      deviceFingerprintSha256: device, fontSha256: [{ resourceId: "font", sha256: sha(new Uint8Array([1, 2, 3])), faceIndex: 0 }], renderedNodeIds: [] }) });
    const report = await buildDashboardPublicationCapabilityReport(input);
    expect(report.objects[0]).toMatchObject({ nodeId: "widget-scene-main", status: "degraded" });
  });
});
