import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseDeepRuntimePackage, serializeDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import {
  createDashboardOfflineArchive,
  dashboardArchiveCanonicalSha256,
  validateDashboardOfflineArchive,
  type DashboardOfflineArchiveV1,
} from "./dashboardOfflineArchive.js";

const authority = {
  projectId: "project-golden",
  applicationId: "dashboard-composition-golden",
  publicationId: "publication-golden",
  applicationRevision: 1,
} as const;
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

async function validArchive() {
  const fixture = new Uint8Array(await readFile(new URL("../../../packages/deep-engine/fixtures/dashboard-composition-v1.json", import.meta.url)));
  const parsed = parseDeepRuntimePackage(fixture);
  if (!parsed.valid) throw new Error("dashboard v5 fixture invalid");
  const artifact = new TextEncoder().encode(serializeDeepRuntimePackage(parsed.value));
  const resource = { id: "font-main", kind: "font" as const, objectKey: "projects/project-golden/fonts/main.woff2",
    mime: "font/woff2", nodeIds: ["node-main"], revision: 1, bytes: 3, sha256: sha(new Uint8Array([1, 2, 3])),
    faceIndex: 0, licenseEvidence: "OFL" };
  const freezeBody = { schema: "deep-engine.dashboard-publication-freeze" as const, schemaVersion: 1 as const, authority,
    entryPageId: "page.378d4cac696fa43e72c270f690e15329771ecf6ff6ac0b2cff9e4a2eca2dac15",
    documentSha256: "a".repeat(64), data: [], resources: [resource], totalBytes: 3 };
  const freezeManifest = { ...freezeBody, manifestSha256: dashboardArchiveCanonicalSha256(freezeBody) };
  const capability = { schema: "deep-engine.dashboard-publication-capability" as const, schemaVersion: 1 as const, authority,
    freezeManifestSha256: freezeManifest.manifestSha256, sourceSemanticHash: "b".repeat(64), compileGraphHash: "c".repeat(64),
    targetArtifactHash: sha(artifact), compiler: { id: "native-dashboard-v5", version: "1.0.0", sha256: "d".repeat(64), configurationSha256: "e".repeat(64) },
    evidence: { verifier: "native-dashboard-window-v1" as const, fixtureSha256: "f".repeat(64), deviceFingerprintSha256: "0".repeat(64),
      fontSha256: [{ resourceId: resource.id, sha256: resource.sha256, faceIndex: 0 }] }, objects: [{ nodeId: "node-main", status: "supported" as const, deferredFields: [] }] };
  return createDashboardOfflineArchive({ freezeManifest, capability, artifact });
}

function resealArchive(input: DashboardOfflineArchiveV1): DashboardOfflineArchiveV1 {
  const archive = structuredClone(input) as DashboardOfflineArchiveV1;
  const freeze = archive.manifest.freezeManifest;
  const { manifestSha256: _freezeHash, ...freezeBody } = freeze;
  const sealedFreeze = { ...freezeBody, manifestSha256: dashboardArchiveCanonicalSha256(freezeBody) };
  const capability = { ...archive.manifest.capability, freezeManifestSha256: sealedFreeze.manifestSha256 };
  const { manifestSha256: _archiveHash, ...archiveBody } = archive.manifest;
  const body = { ...archiveBody, freezeManifest: sealedFreeze, freezeManifestSha256: sealedFreeze.manifestSha256,
    resourceClosureSha256: dashboardArchiveCanonicalSha256(sealedFreeze.resources), capability,
    capabilitySha256: dashboardArchiveCanonicalSha256(capability) };
  return { artifact: Uint8Array.from(archive.artifact), manifest: { ...body, manifestSha256: dashboardArchiveCanonicalSha256(body) } };
}

describe("dashboard offline archive contract", () => {
  it("binds a canonical v5 package to C3 frozen closure and all three C4 hashes", async () => {
    const archive = await validArchive();
    const result = validateDashboardOfflineArchive(archive);
    expect(result.runtimePackage.schemaVersion).toBe(5);
    expect(result.archive.manifest).toMatchObject({ target: "deep-native-dashboard-v5", authority,
      sourceSemanticHash: "b".repeat(64), compileGraphHash: "c".repeat(64), targetArtifactHash: sha(archive.artifact) });
    expect(result.archive.artifact).not.toBe(archive.artifact);
  });

  it("fails closed when manifest, embedded capability, or artifact bytes are tampered", async () => {
    const archive = await validArchive();
    expect(() => validateDashboardOfflineArchive({ ...archive, manifest: { ...archive.manifest, sourceSemanticHash: "9".repeat(64) } })).toThrow("manifest was modified");
    const alteredCapability = structuredClone(archive) as DashboardOfflineArchiveV1;
    alteredCapability.manifest.capability.evidence.fontSha256[0]!.sha256 = "8".repeat(64);
    const { manifestSha256: _hash, ...body } = alteredCapability.manifest;
    alteredCapability.manifest.manifestSha256 = dashboardArchiveCanonicalSha256(body);
    expect(() => validateDashboardOfflineArchive(alteredCapability)).toThrow("capability report was modified");
    expect(() => validateDashboardOfflineArchive({ ...archive, artifact: Uint8Array.from([...archive.artifact, 10]) })).toThrow();
  });

  it("rejects a resealed archive whose frozen font closure is missing", async () => {
    const archive = await validArchive();
    const missing = structuredClone(archive) as DashboardOfflineArchiveV1;
    missing.manifest.freezeManifest.resources = [];
    const resealed = resealArchive(missing);
    expect(() => validateDashboardOfflineArchive(resealed)).toThrow("missing frozen font resources");
  });

  it("rejects any target other than the native v5 dashboard player", async () => {
    const archive = await validArchive();
    const wrongTarget = structuredClone(archive) as DashboardOfflineArchiveV1;
    wrongTarget.manifest.target = "web-dashboard-v5" as never;
    const { manifestSha256: _hash, ...body } = wrongTarget.manifest;
    wrongTarget.manifest.manifestSha256 = dashboardArchiveCanonicalSha256(body);
    expect(() => validateDashboardOfflineArchive(wrongTarget)).toThrow("target or schema");
  });
});
