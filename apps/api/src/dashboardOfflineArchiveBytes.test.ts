import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseDeepRuntimePackage, serializeDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { createDashboardOfflineArchive, dashboardArchiveCanonicalSha256 } from "./dashboardOfflineArchive.js";
import { parseDashboardOfflineArchive, serializeDashboardOfflineArchive } from "./dashboardOfflineArchiveBytes.js";

const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

async function validArchive() {
  const fixture = new Uint8Array(await readFile(new URL("../../../packages/deep-engine/fixtures/dashboard-composition-v1.json", import.meta.url)));
  const parsed = parseDeepRuntimePackage(fixture);
  if (!parsed.valid) throw new Error("dashboard fixture invalid");
  const artifact = new TextEncoder().encode(serializeDeepRuntimePackage(parsed.value));
  const authority = { projectId: "project-golden", applicationId: "dashboard-composition-golden", publicationId: "publication-golden", applicationRevision: 1 } as const;
  const resource = { id: "font-main", kind: "font" as const, objectKey: "projects/project-golden/fonts/main.woff2", mime: "font/woff2", nodeIds: ["node-main"], revision: 1, bytes: 3, sha256: sha(Uint8Array.of(1, 2, 3)), faceIndex: 0, licenseEvidence: "OFL" };
  const freezeBody = { schema: "deep-engine.dashboard-publication-freeze" as const, schemaVersion: 1 as const, authority, entryPageId: "page.378d4cac696fa43e72c270f690e15329771ecf6ff6ac0b2cff9e4a2eca2dac15", documentSha256: "a".repeat(64), data: [], resources: [resource], totalBytes: 3 };
  const freezeManifest = { ...freezeBody, manifestSha256: dashboardArchiveCanonicalSha256(freezeBody) };
  const capability = { schema: "deep-engine.dashboard-publication-capability" as const, schemaVersion: 1 as const, authority, freezeManifestSha256: freezeManifest.manifestSha256, sourceSemanticHash: "b".repeat(64), compileGraphHash: "c".repeat(64), targetArtifactHash: sha(artifact), compiler: { id: "native-dashboard-v5", version: "1.0.0", sha256: "d".repeat(64), configurationSha256: "e".repeat(64) }, evidence: { verifier: "native-dashboard-window-v1" as const, fixtureSha256: "f".repeat(64), deviceFingerprintSha256: "0".repeat(64), fontSha256: [{ resourceId: resource.id, sha256: resource.sha256, faceIndex: 0 }] }, objects: [{ nodeId: "node-main", status: "supported" as const, deferredFields: [] }] };
  return createDashboardOfflineArchive({ freezeManifest, capability, artifact });
}

describe("dashboard offline archive bytes", () => {
  it("round-trips canonical archive bytes deterministically", async () => {
    const archive = await validArchive();
    const first = serializeDashboardOfflineArchive(archive);
    const second = serializeDashboardOfflineArchive(structuredClone(archive));
    expect(second).toEqual(first);
    const parsed = parseDashboardOfflineArchive(first);
    expect(parsed.archive.manifest.manifestSha256).toBe(archive.manifest.manifestSha256);
    expect(parsed.archive.artifact).toEqual(archive.artifact);
    expect(parsed.archive.artifact).not.toBe(archive.artifact);
  });

  it("rejects malformed framing, noncanonical JSON, and payload tampering", async () => {
    const bytes = serializeDashboardOfflineArchive(await validArchive());
    expect(() => parseDashboardOfflineArchive(bytes.subarray(0, 11))).toThrow("truncated");
    const wrongMagic = Uint8Array.from(bytes); wrongMagic[0] ^= 1;
    expect(() => parseDashboardOfflineArchive(wrongMagic)).toThrow("byte format");
    const badLength = Uint8Array.from(bytes); new DataView(badLength.buffer).setUint32(8, 0xffff_ffff, false);
    expect(() => parseDashboardOfflineArchive(badLength)).toThrow("lengths");
    const manifestLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, false);
    const noncanonical = new Uint8Array(bytes.byteLength + 1);
    noncanonical.set(bytes.subarray(0, 12));
    new DataView(noncanonical.buffer).setUint32(8, manifestLength + 1, false);
    noncanonical[12] = 0x20;
    noncanonical.set(bytes.subarray(12), 13);
    expect(() => parseDashboardOfflineArchive(noncanonical)).toThrow("not canonical");
    const alteredArtifact = Uint8Array.from(bytes); alteredArtifact[alteredArtifact.byteLength - 1] ^= 1;
    expect(() => parseDashboardOfflineArchive(alteredArtifact)).toThrow();
  });
});
