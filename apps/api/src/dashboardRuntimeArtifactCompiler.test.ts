import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { assertDashboardDocument, type PublishedApplicationRecord } from "@bim-studio/contracts";
import { parseDeepRuntimePackage, serializeDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import source from "../../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json";
import { buildDashboardPublicationCapabilityReport } from "./dashboardPublicationCapability.js";
import { prepareDashboardPublicationFreeze, type DashboardFrozenResourceRequest } from "./dashboardPublicationFreeze.js";
import {
  acceptDashboardRuntimeArtifactCompilerOutput,
  prepareDashboardRuntimeArtifactCompilerInput,
  type DashboardFreezeRevalidation,
} from "./dashboardRuntimeArtifactCompiler.js";

const authority = { projectId: "project-golden", applicationId: "application-worker-behavior", publicationId: "publication-1", applicationRevision: 1 } as const;
const compiler = { id: "native-dashboard-v5", version: "1.0.0", sha256: "c".repeat(64), configuration: { antialias: "msaa4", runtimeSchema: 5 } } as const;
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

function state() {
  const value: unknown = structuredClone(source); assertDashboardDocument(value);
  const publication: PublishedApplicationRecord = { id: authority.publicationId, projectId: authority.projectId,
    applicationId: authority.applicationId, applicationRevision: authority.applicationRevision, document: value.application,
    publishedAt: "2026-09-16T12:00:00.000Z" };
  return { activePublicationId: authority.publicationId, currentApplicationRevision: authority.applicationRevision, publication };
}
function font(): DashboardFrozenResourceRequest {
  return { id: "font", kind: "font", objectKey: "projects/project-golden/assets/font.woff2", mime: "font/woff2",
    nodeIds: ["widget-scene-main"], revision: 2, faceIndex: 0, license: { redistributable: true, evidence: "OFL" } };
}
function revalidation(): DashboardFreezeRevalidation {
  return { readAuthority: async () => state(), resolveData: async () => ({ sourceRevision: "", value: null }),
    readResource: async () => ({ revision: 2, bytes: new Uint8Array([1, 2, 3]) }) };
}
async function frozen() {
  return prepareDashboardPublicationFreeze({ expected: authority, entryPageId: "page-main", data: [], resources: [font()], ...revalidation() });
}
async function artifact(): Promise<Uint8Array> {
  const sourceBytes = new Uint8Array(await readFile(new URL("../../../packages/deep-engine/fixtures/dashboard-composition-v1.json", import.meta.url)));
  const parsed = parseDeepRuntimePackage(sourceBytes);
  if (!parsed.valid || parsed.value.schemaVersion !== 5) throw new Error("Test v5 fixture invalid");
  return new TextEncoder().encode(serializeDeepRuntimePackage(parsed.value));
}
async function capability(candidate: Awaited<ReturnType<typeof frozen>>, bytes: Uint8Array) {
  return buildDashboardPublicationCapabilityReport({ candidate, expectedDeviceFingerprintSha256: "a".repeat(64), revalidation: revalidation(),
    compiler: { compilerId: compiler.id, compilerVersion: compiler.version, compilerSha256: compiler.sha256, configuration: compiler.configuration,
      compile: async () => ({ artifact: bytes, objects: [{ nodeId: "widget-scene-main", contentCompiled: true, deferredFields: [] }] }) },
    verifyWindow: async request => ({ verifier: "native-dashboard-window-v1", authority, freezeManifestSha256: candidate.manifest.manifestSha256,
      sourceSemanticHash: request.sourceSemanticHash, compileGraphHash: request.compileGraphHash, targetArtifactHash: request.targetArtifactHash,
      fixtureSha256: "b".repeat(64), deviceFingerprintSha256: "a".repeat(64),
      fontSha256: [{ resourceId: "font", sha256: sha(new Uint8Array([1, 2, 3])), faceIndex: 0 }], renderedNodeIds: ["widget-scene-main"] }),
  });
}

describe("dashboard v5 runtime compiler contract", () => {
  it("snapshots the C3 candidate and accepts exactly the C4-proven canonical v5 bytes", async () => {
    const candidate = await frozen(), bytes = await artifact(), report = await capability(candidate, bytes);
    const input = await prepareDashboardRuntimeArtifactCompilerInput({ candidate, capability: report, compiler, revalidation: revalidation() });
    const accepted = acceptDashboardRuntimeArtifactCompilerOutput(input, { protocol: input.protocol, authority: input.authority,
      freezeManifestSha256: input.freezeManifestSha256, sourceSemanticHash: input.sourceSemanticHash,
      compileGraphHash: input.compileGraphHash, artifact: bytes }, report);
    expect(accepted).toMatchObject({ artifactSha256: report.targetArtifactHash, authority, freezeManifestSha256: candidate.manifest.manifestSha256 });
    expect(accepted.runtimePackage.schemaVersion).toBe(5);
    expect(input.resources.font).not.toBe(candidate.resources.font);
  });

  it("rejects compiler/capability substitution before work and stale authority during preparation", async () => {
    const candidate = await frozen(), bytes = await artifact(), report = await capability(candidate, bytes);
    await expect(prepareDashboardRuntimeArtifactCompilerInput({ candidate, capability: report,
      compiler: { ...compiler, sha256: "d".repeat(64) }, revalidation: revalidation() })).rejects.toThrow("capability report");
    await expect(prepareDashboardRuntimeArtifactCompilerInput({ candidate, capability: report, compiler, revalidation: {
      ...revalidation(), readAuthority: async () => ({ ...state(), currentApplicationRevision: 2 }),
    } })).rejects.toThrow("authority changed");
  });

  it("fails closed for changed authority/hash, noncanonical bytes, and non-v5 artifacts", async () => {
    const candidate = await frozen(), bytes = await artifact(), report = await capability(candidate, bytes);
    const input = await prepareDashboardRuntimeArtifactCompilerInput({ candidate, capability: report, compiler, revalidation: revalidation() });
    const output = () => ({ protocol: input.protocol, authority: input.authority, freezeManifestSha256: input.freezeManifestSha256,
      sourceSemanticHash: input.sourceSemanticHash, compileGraphHash: input.compileGraphHash, artifact: bytes });
    expect(() => acceptDashboardRuntimeArtifactCompilerOutput(input, { ...output(), authority: { ...authority, publicationId: "other" } }, report)).toThrow("not bound");
    expect(() => acceptDashboardRuntimeArtifactCompilerOutput(input, { ...output(), artifact: Uint8Array.from([...bytes, 10]) }, report)).toThrow();
    const v4 = new Uint8Array(await readFile(new URL("../../../packages/deep-engine/fixtures/dashboard-runtime-v1.json", import.meta.url)));
    expect(() => acceptDashboardRuntimeArtifactCompilerOutput(input, { ...output(), artifact: v4 }, report)).toThrow();
  });
});
