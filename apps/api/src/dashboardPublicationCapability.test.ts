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
        { nodeId: "second", contentCompiled: false, deferredFields: ["widget.video"] }] }) },
    verifyWindow: async (request: { sourceSemanticHash: string; compileGraphHash: string; targetArtifactHash: string }) => ({
      verifier: "native-dashboard-window-v1", authority, freezeManifestSha256: frozen.manifest.manifestSha256,
      sourceSemanticHash: request.sourceSemanticHash, compileGraphHash: request.compileGraphHash, targetArtifactHash: request.targetArtifactHash,
      fixtureSha256: "b".repeat(64), deviceFingerprintSha256: device,
      fontSha256: [{ resourceId: "font", sha256: sha(new Uint8Array([1, 2, 3])), faceIndex: 0 }], renderedNodeIds: ["widget-scene-main"], ...patch }),
  } as const;
}

describe("dashboard publication capability report", () => {
  it("passes an owned copy of compiler node and font evidence to the window verifier", async () => {
    const input = inputs(await candidate());
    const compile = input.compiler.compile;
    const windowEvidence = { nodeBindings: [{ nodeId: "widget-scene-main", runtimeNodeId: "runtime-node",
      pageId: "runtime-page", staticResourceId: "static" }], fontBindings: [
        { resourceId: "font", sha256: sha(new Uint8Array([1, 2, 3])), faceIndex: 0, runtimeNodeId: "runtime-node", atlasId: "atlas" }] };
    Object.assign(input.compiler, { compile: async () => ({ ...await compile(), windowEvidence }) });
    const verify = input.verifyWindow;
    await buildDashboardPublicationCapabilityReport({ ...input, verifyWindow: async request => {
      expect(request.windowEvidence).toEqual(windowEvidence);
      expect(request.windowEvidence).not.toBe(windowEvidence);
      expect(request.windowEvidence?.nodeBindings).not.toBe(windowEvidence.nodeBindings);
      return verify(request);
    } });
  });

  it("keeps uncompiled fields degraded even when the object was rendered", async () => {
    const input = inputs(await candidate());
    const compile = input.compiler.compile;
    Object.assign(input.compiler, { compile: async () => {
      const result = await compile();
      return { ...result, objects: result.objects.map(object => ({ ...object, deferredFields: ["widget.interactions"] })) };
    } });
    expect((await buildDashboardPublicationCapabilityReport(input)).objects[0]).toMatchObject({ status: "degraded" });
  });

  it("reports omitted authored objects as blocked rather than silently dropping them", async () => {
    const input = inputs(await candidate());
    const compile = input.compiler.compile;
    Object.assign(input.compiler, { compile: async () => {
      const result = await compile(); return { ...result, objects: result.objects.slice(0, 1) };
    } });
    expect((await buildDashboardPublicationCapabilityReport(input)).objects).toContainEqual({
      nodeId: "second", status: "blocked", deferredFields: ["$"],
    });
  });

  it("rejects compiler object identities absent from the frozen document", async () => {
    const input = inputs(await candidate());
    const compile = input.compiler.compile;
    Object.assign(input.compiler, { compile: async () => {
      const result = await compile(); return { ...result, objects: [...result.objects,
        { nodeId: "invented", contentCompiled: true, deferredFields: [] }] };
    } });
    await expect(buildDashboardPublicationCapabilityReport(input)).rejects.toThrow(/unknown dashboard object/);
  });

  it("binds the three hashes to frozen authority, actual target bytes, device and font closure", async () => {
    const frozen = await candidate(), report = await buildDashboardPublicationCapabilityReport(inputs(frozen));
    expect(report).toMatchObject({ authority, freezeManifestSha256: frozen.manifest.manifestSha256,
      targetArtifactHash: sha(new Uint8Array([9, 8, 7])), objects: [{ nodeId: "widget-scene-main", status: "supported" },
        { nodeId: "second", status: "blocked" }] });
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

async function coverageInput(multiPage = false) {
  const authoritative = state();
  if (multiPage) {
    const page = authoritative.publication.document.pages[0]!;
    authoritative.publication.document.pages.push({ ...structuredClone(page), id: "page-second", nodes: [page.nodes.pop()!] });
  }
  const readAuthority = async () => authoritative;
  const bytes = new Uint8Array([1, 2, 3]);
  const resources = [font(), { ...font(), id: "unused-fallback" },
    { ...font(), id: "other-page-font", nodeIds: ["second"] }];
  const frozen = await prepareDashboardPublicationFreeze({ expected: authority, entryPageId: "page-main", data: [], resources,
    readAuthority, resolveData: async () => ({ sourceRevision: "", value: null }), readResource: async () => ({ revision: 2, bytes }) });
  const input = inputs(frozen);
  Object.assign(input.revalidation, { readAuthority });
  const evidence = { nodeBindings: [
    { nodeId: "widget-scene-main", runtimeNodeId: "runtime-main", pageId: "runtime-page-main", staticResourceId: "static-main" },
    { nodeId: "second", runtimeNodeId: "runtime-second", pageId: "runtime-page-second", staticResourceId: "static-second" },
  ], fontBindings: [
    { resourceId: "font", sha256: sha(bytes), faceIndex: 0, runtimeNodeId: "runtime-main", atlasId: "atlas-main" },
    { resourceId: "other-page-font", sha256: sha(bytes), faceIndex: 0, runtimeNodeId: "runtime-second", atlasId: "atlas-second" },
  ] };
  Object.assign(input.compiler, { compile: async () => ({ artifact: new Uint8Array([9, 8, 7]), windowEvidence: evidence,
    objects: [{ nodeId: "widget-scene-main", contentCompiled: true, deferredFields: [] },
      { nodeId: "second", contentCompiled: true, deferredFields: [] }] }) });
  return { input, evidence };
}

describe("compiler-bound font coverage", () => {
  it("accepts a frozen but unused fallback while supporting only the verified node", async () => {
    const { input } = await coverageInput();
    const report = await buildDashboardPublicationCapabilityReport(input);
    expect(report.objects.map(object => object.status)).toEqual(["supported", "degraded"]);
    expect(report.evidence.fontSha256.map(font => font.resourceId)).toEqual(["font"]);
  });
  it("leaves the unpresented second page degraded without requiring its font in the receipt", async () => {
    const { input } = await coverageInput(true);
    expect((await buildDashboardPublicationCapabilityReport(input)).objects).toEqual([
      { nodeId: "widget-scene-main", status: "supported", deferredFields: [] },
      { nodeId: "second", status: "degraded", deferredFields: [] },
    ]);
  });
  it("does not support a rendered node whose compiler-used font was not verified", async () => {
    const { input } = await coverageInput();
    const verify = input.verifyWindow;
    const report = await buildDashboardPublicationCapabilityReport({ ...input, verifyWindow: async request => ({ ...await verify(request), fontSha256: [] }) });
    expect(report.objects[0]!.status).toBe("degraded");
  });
  it.each(["unused-fallback", "other-page-font", "invented"])("rejects unattested %s as a drawn font", async resourceId => {
    const { input } = await coverageInput(true), verify = input.verifyWindow;
    await expect(buildDashboardPublicationCapabilityReport({ ...input, verifyWindow: async request => ({ ...await verify(request),
      fontSha256: [{ resourceId, sha256: sha(new Uint8Array([1, 2, 3])), faceIndex: 0 }] }) })).rejects.toThrow(/compiler-bound/);
  });
  it("rejects substituted font faces and compiler font consumers outside the closure", async () => {
    const { input, evidence } = await coverageInput();
    evidence.fontBindings[0]!.faceIndex = 1;
    await expect(buildDashboardPublicationCapabilityReport(input)).rejects.toThrow(/frozen font closure/);
    evidence.fontBindings[0]!.faceIndex = 0; evidence.fontBindings[0]!.runtimeNodeId = "runtime-second";
    await expect(buildDashboardPublicationCapabilityReport(input)).rejects.toThrow(/frozen font closure/);
  });
  it("does not allow the verifier to remove required font coverage by mutating compiler evidence", async () => {
    const { input, evidence } = await coverageInput(), verify = input.verifyWindow;
    const report = await buildDashboardPublicationCapabilityReport({ ...input, verifyWindow: async request => {
      evidence.fontBindings.length = 0;
      (request.windowEvidence!.fontBindings as unknown[]).length = 0;
      return { ...await verify(request), fontSha256: [] };
    } });
    expect(report.objects[0]!.status).toBe("degraded");
  });
  it("retains complete frozen-font equality for legacy compilers without provenance", async () => {
    const input = inputs(await candidate(), { fontSha256: [] });
    await expect(buildDashboardPublicationCapabilityReport(input)).rejects.toThrow(/frozen font closure/);
  });
});
