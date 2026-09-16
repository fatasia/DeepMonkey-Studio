import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseDeepRuntimePackage, serializeDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { createDashboardOfflineArchive, dashboardArchiveCanonicalSha256 } from "./dashboardOfflineArchive.js";
import { serializeDashboardOfflineArchive } from "./dashboardOfflineArchiveBytes.js";
import { createDashboardOfflineNativeLaunchPlan } from "./dashboardOfflineNativeLauncher.js";

const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

async function validArchiveBytes(): Promise<Uint8Array> {
  const fixture = new Uint8Array(await readFile(new URL("../../../packages/deep-engine/fixtures/dashboard-composition-v1.json", import.meta.url)));
  const parsed = parseDeepRuntimePackage(fixture);
  if (!parsed.valid) throw new Error("dashboard fixture invalid");
  const artifact = new TextEncoder().encode(serializeDeepRuntimePackage(parsed.value));
  const authority = { projectId: "project-golden", applicationId: "dashboard-composition-golden", publicationId: "publication-golden", applicationRevision: 1 } as const;
  const resource = { id: "font-main", kind: "font" as const, objectKey: "projects/project-golden/fonts/main.woff2", mime: "font/woff2", nodeIds: ["node-main"], revision: 1, bytes: 3, sha256: sha(Uint8Array.of(1, 2, 3)), faceIndex: 0, licenseEvidence: "OFL" };
  const freezeBody = { schema: "deep-engine.dashboard-publication-freeze" as const, schemaVersion: 1 as const, authority, entryPageId: "page.378d4cac696fa43e72c270f690e15329771ecf6ff6ac0b2cff9e4a2eca2dac15", documentSha256: "a".repeat(64), data: [], resources: [resource], totalBytes: 3 };
  const freezeManifest = { ...freezeBody, manifestSha256: dashboardArchiveCanonicalSha256(freezeBody) };
  const capability = { schema: "deep-engine.dashboard-publication-capability" as const, schemaVersion: 1 as const, authority, freezeManifestSha256: freezeManifest.manifestSha256, sourceSemanticHash: "b".repeat(64), compileGraphHash: "c".repeat(64), targetArtifactHash: sha(artifact), compiler: { id: "native-dashboard-v5", version: "1.0.0", sha256: "d".repeat(64), configurationSha256: "e".repeat(64) }, evidence: { verifier: "native-dashboard-window-v1" as const, fixtureSha256: "f".repeat(64), deviceFingerprintSha256: "0".repeat(64), fontSha256: [{ resourceId: resource.id, sha256: resource.sha256, faceIndex: 0 }] }, objects: [{ nodeId: "node-main", status: "supported" as const, deferredFields: [] }] };
  return serializeDashboardOfflineArchive(createDashboardOfflineArchive({ freezeManifest, capability, artifact }));
}

describe("dashboard offline native launcher", () => {
  it("turns verified DMDA bytes into a minimal local native plan", async () => {
    const bytes = await validArchiveBytes();
    const plan = createDashboardOfflineNativeLaunchPlan(bytes);
    expect(plan).toMatchObject({ protocol: "dashboard-offline-native-launch-plan-v1", target: "deep-native-dashboard-v5", authority: { projectId: "project-golden", applicationId: "dashboard-composition-golden", publicationId: "publication-golden", applicationRevision: 1 }, sourceSemanticHash: "b".repeat(64), compileGraphHash: "c".repeat(64), targetArtifactHash: sha(plan.artifact) });
    expect(Object.keys(plan).sort()).toEqual(["archiveManifestSha256", "artifact", "authority", "compileGraphHash", "entryPageId", "protocol", "runtimePackageSha256", "sourceSemanticHash", "target", "targetArtifactHash"]);
    expect(JSON.stringify(plan)).not.toContain("objectKey");
    expect(JSON.stringify(plan)).not.toContain("https:");
    expect(JSON.stringify(plan)).not.toContain("browser");
  });

  it("copies archive payloads so native-plan mutation cannot change caller bytes", async () => {
    const bytes = await validArchiveBytes();
    const before = Uint8Array.from(bytes);
    const plan = createDashboardOfflineNativeLaunchPlan(bytes);
    plan.artifact[0] ^= 1;
    expect(bytes).toEqual(before);
    expect(plan.authority).not.toBeUndefined();
  });

  it("fails closed for malformed or artifact-tampered DMDA bytes", async () => {
    const bytes = await validArchiveBytes();
    expect(() => createDashboardOfflineNativeLaunchPlan(bytes.subarray(0, 11))).toThrow("truncated");
    const altered = Uint8Array.from(bytes);
    altered[altered.byteLength - 1] ^= 1;
    expect(() => createDashboardOfflineNativeLaunchPlan(altered)).toThrow();
  });
});
