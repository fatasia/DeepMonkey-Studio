import { parseDashboardOfflineArchive } from "./dashboardOfflineArchiveBytes.js";
import type { DashboardPublicationAuthorityToken } from "./dashboardPublicationFreeze.js";

/**
 * The only data a native Dashboard process needs after a DMDA archive has
 * passed its provenance checks. This type deliberately has no URL, object key,
 * browser state, credential, or live data field.
 */
export interface DashboardOfflineNativeLaunchPlanV1 {
  readonly protocol: "dashboard-offline-native-launch-plan-v1";
  readonly target: "deep-native-dashboard-v5";
  readonly authority: DashboardPublicationAuthorityToken;
  readonly entryPageId: string;
  readonly archiveManifestSha256: string;
  readonly sourceSemanticHash: string;
  readonly compileGraphHash: string;
  readonly targetArtifactHash: string;
  readonly runtimePackageSha256: string;
  /** Canonical v5 runtime-package bytes, copied out of the verified archive. */
  readonly artifact: Uint8Array;
}

/**
 * Converts untrusted DMDA bytes into a minimal local-native launch plan. The
 * archive parser verifies the envelope, C3 frozen closure, C4 receipt, and
 * canonical v5 package before this function selects the fields a launcher can
 * observe. Nothing from browser input or object storage is accepted here.
 */
export function createDashboardOfflineNativeLaunchPlan(
  archiveBytes: Uint8Array,
): DashboardOfflineNativeLaunchPlanV1 {
  const verified = parseDashboardOfflineArchive(archiveBytes);
  const manifest = verified.archive.manifest;
  return Object.freeze({
    protocol: "dashboard-offline-native-launch-plan-v1",
    target: "deep-native-dashboard-v5",
    authority: Object.freeze({
      projectId: manifest.authority.projectId,
      applicationId: manifest.authority.applicationId,
      publicationId: manifest.authority.publicationId,
      applicationRevision: manifest.authority.applicationRevision,
    }),
    entryPageId: manifest.freezeManifest.entryPageId,
    archiveManifestSha256: manifest.manifestSha256,
    sourceSemanticHash: manifest.sourceSemanticHash,
    compileGraphHash: manifest.compileGraphHash,
    targetArtifactHash: manifest.targetArtifactHash,
    runtimePackageSha256: manifest.runtimePackageSha256,
    artifact: Uint8Array.from(verified.archive.artifact),
  });
}
