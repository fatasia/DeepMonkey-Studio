import { createHash } from "node:crypto";
import {
  parseDeepRuntimePackage,
  serializeDeepRuntimePackage,
  type DeepRuntimePackageV5,
} from "@bim-studio/deep-engine/runtime-package";
import type { DashboardPublicationCapabilityReport } from "./dashboardPublicationCapability.js";
import type {
  DashboardPublicationAuthorityToken,
  DashboardPublicationFreezeManifest,
} from "./dashboardPublicationFreeze.js";

const SHA256 = /^[a-f0-9]{64}$/;

/**
 * The portable, storage-free proof for an offline native Dashboard player.
 * It deliberately contains no scene archive references, route URLs, object
 * credentials, or live data handles. The artifact is the canonical v5 package.
 */
export interface DashboardOfflineArchiveManifestV1 {
  readonly schema: "deep-engine.dashboard-offline-archive";
  readonly schemaVersion: 1;
  readonly target: "deep-native-dashboard-v5";
  readonly authority: DashboardPublicationAuthorityToken;
  readonly freezeManifest: DashboardPublicationFreezeManifest;
  readonly freezeManifestSha256: string;
  /** Exact resource closure from C3, so absent fonts/images cannot be hidden. */
  readonly resourceClosureSha256: string;
  /** C4 verifier receipt, embedded to keep the archive independently auditable. */
  readonly capability: DashboardPublicationCapabilityReport;
  readonly capabilitySha256: string;
  /** The C4 source, compiler graph, and target-artifact identity triple. */
  readonly sourceSemanticHash: string;
  readonly compileGraphHash: string;
  readonly targetArtifactHash: string;
  /** packageHash from the canonical runtime package payload. */
  readonly runtimePackageSha256: string;
  readonly manifestSha256: string;
}

export interface DashboardOfflineArchiveV1 {
  readonly manifest: DashboardOfflineArchiveManifestV1;
  readonly artifact: Uint8Array;
}

export interface CreateDashboardOfflineArchiveOptions {
  readonly freezeManifest: DashboardPublicationFreezeManifest;
  readonly capability: DashboardPublicationCapabilityReport;
  readonly artifact: Uint8Array;
}

export interface ValidatedDashboardOfflineArchive {
  readonly archive: DashboardOfflineArchiveV1;
  readonly runtimePackage: DeepRuntimePackageV5;
}

/** Build an offline archive only after the frozen C3 closure and C4 receipt agree. */
export function createDashboardOfflineArchive(options: CreateDashboardOfflineArchiveOptions): DashboardOfflineArchiveV1 {
  const freezeManifest = snapshot(options.freezeManifest);
  const capability = snapshot(options.capability);
  const artifact = Uint8Array.from(options.artifact);
  const runtimePackage = parseCanonicalV5(artifact);
  assertFreezeManifest(freezeManifest);
  assertCapability(capability, freezeManifest, artifact);
  assertRuntimeDocumentBinding(runtimePackage, freezeManifest);
  const body = {
    schema: "deep-engine.dashboard-offline-archive" as const,
    schemaVersion: 1 as const,
    target: "deep-native-dashboard-v5" as const,
    authority: snapshot(freezeManifest.authority),
    freezeManifest,
    freezeManifestSha256: freezeManifest.manifestSha256,
    resourceClosureSha256: canonicalSha256(freezeManifest.resources),
    capability,
    capabilitySha256: canonicalSha256(capability),
    sourceSemanticHash: capability.sourceSemanticHash,
    compileGraphHash: capability.compileGraphHash,
    targetArtifactHash: capability.targetArtifactHash,
    runtimePackageSha256: runtimePackage.packageHash.value,
  };
  const manifest = Object.freeze({ ...body, manifestSha256: canonicalSha256(body) });
  return Object.freeze({ manifest, artifact });
}

/**
 * Validate untrusted archive bytes/JSON without invoking storage, routing, or a
 * compiler. Callers receive copied bytes only after every provenance edge holds.
 */
export function validateDashboardOfflineArchive(input: DashboardOfflineArchiveV1): ValidatedDashboardOfflineArchive {
  if (!input || typeof input !== "object" || !(input.artifact instanceof Uint8Array)) {
    throw new Error("Dashboard offline archive requires manifest and artifact bytes");
  }
  const manifest = snapshot(input.manifest);
  const artifact = Uint8Array.from(input.artifact);
  assertManifestShape(manifest);
  const { manifestSha256, ...body } = manifest;
  if (manifestSha256 !== canonicalSha256(body)) throw new Error("Dashboard offline archive manifest was modified");
  assertFreezeManifest(manifest.freezeManifest);
  if (!equal(manifest.authority, manifest.freezeManifest.authority)
    || manifest.freezeManifestSha256 !== manifest.freezeManifest.manifestSha256
    || manifest.resourceClosureSha256 !== canonicalSha256(manifest.freezeManifest.resources)) {
    throw new Error("Dashboard offline archive is not bound to its frozen resource closure");
  }
  if (manifest.capabilitySha256 !== canonicalSha256(manifest.capability)) {
    throw new Error("Dashboard offline archive capability report was modified");
  }
  const runtimePackage = parseCanonicalV5(artifact);
  assertCapability(manifest.capability, manifest.freezeManifest, artifact);
  assertRuntimeDocumentBinding(runtimePackage, manifest.freezeManifest);
  if (manifest.sourceSemanticHash !== manifest.capability.sourceSemanticHash
    || manifest.compileGraphHash !== manifest.capability.compileGraphHash
    || manifest.targetArtifactHash !== manifest.capability.targetArtifactHash
    || manifest.runtimePackageSha256 !== runtimePackage.packageHash.value) {
    throw new Error("Dashboard offline archive identity triple does not match capability or runtime package");
  }
  return Object.freeze({ archive: Object.freeze({ manifest, artifact }), runtimePackage });
}

function assertManifestShape(manifest: DashboardOfflineArchiveManifestV1): void {
  if (!manifest || typeof manifest !== "object" || manifest.schema !== "deep-engine.dashboard-offline-archive"
    || manifest.schemaVersion !== 1 || manifest.target !== "deep-native-dashboard-v5") {
    throw new Error("Unsupported dashboard offline archive target or schema");
  }
  for (const [label, value] of Object.entries({
    "Offline archive manifest": manifest.manifestSha256,
    "Frozen manifest": manifest.freezeManifestSha256,
    "Offline resource closure": manifest.resourceClosureSha256,
    "Offline capability": manifest.capabilitySha256,
    "Offline source semantic": manifest.sourceSemanticHash,
    "Offline compile graph": manifest.compileGraphHash,
    "Offline target artifact": manifest.targetArtifactHash,
    "Offline runtime package": manifest.runtimePackageSha256,
  })) assertHash(value, label);
}

function assertFreezeManifest(manifest: DashboardPublicationFreezeManifest): void {
  if (!manifest || typeof manifest !== "object" || manifest.schema !== "deep-engine.dashboard-publication-freeze"
    || manifest.schemaVersion !== 1 || !Array.isArray(manifest.resources) || !Array.isArray(manifest.data)) {
    throw new Error("Dashboard offline archive has an invalid frozen manifest");
  }
  const { manifestSha256, ...body } = manifest;
  if (!SHA256.test(manifestSha256) || manifestSha256 !== canonicalSha256(body)) {
    throw new Error("Dashboard offline archive frozen manifest was modified");
  }
  assertAuthority(manifest.authority);
  assertHash(manifest.documentSha256, "Frozen document");
  const resources = new Set<string>();
  for (const resource of manifest.resources) {
    if (!resource || !resource.id || resources.has(resource.id) || !Number.isSafeInteger(resource.bytes) || resource.bytes < 1) {
      throw new Error("Dashboard offline archive frozen resource closure is invalid");
    }
    resources.add(resource.id); assertHash(resource.sha256, `Frozen resource ${resource.id}`);
  }
}

function assertCapability(capability: DashboardPublicationCapabilityReport, freezeManifest: DashboardPublicationFreezeManifest,
  artifact: Uint8Array): void {
  if (!capability || typeof capability !== "object" || capability.schema !== "deep-engine.dashboard-publication-capability"
    || capability.schemaVersion !== 1 || !equal(capability.authority, freezeManifest.authority)
    || capability.freezeManifestSha256 !== freezeManifest.manifestSha256) {
    throw new Error("Dashboard offline archive capability is not bound to the frozen publication");
  }
  for (const [label, value] of Object.entries({
    "Capability source semantic": capability.sourceSemanticHash,
    "Capability compile graph": capability.compileGraphHash,
    "Capability target artifact": capability.targetArtifactHash,
  })) assertHash(value, label);
  if (capability.targetArtifactHash !== sha256(artifact)) throw new Error("Dashboard offline archive artifact differs from capability target");
  const expectedFonts = freezeManifest.resources.filter(item => item.kind === "font")
    .map(item => ({ resourceId: item.id, sha256: item.sha256, faceIndex: item.faceIndex }))
    .sort(fontOrder);
  const actualFonts = capability.evidence?.fontSha256?.map(font => ({ ...font })).sort(fontOrder);
  if (!actualFonts || !equal(expectedFonts, actualFonts)) {
    throw new Error("Dashboard offline archive capability is missing frozen font resources");
  }
}

function assertRuntimeDocumentBinding(runtimePackage: DeepRuntimePackageV5, freezeManifest: DashboardPublicationFreezeManifest): void {
  const dashboardId = runtimePackage.entrypoints.dashboard;
  const dashboard = runtimePackage.payloads[dashboardId] as Record<string, unknown>;
  if (!dashboard || dashboard.documentId !== freezeManifest.authority.applicationId
    || dashboard.documentRevision !== freezeManifest.authority.applicationRevision
    || dashboard.entryPageId !== freezeManifest.entryPageId) {
    throw new Error("Dashboard offline runtime package targets a different frozen document");
  }
}

function parseCanonicalV5(artifact: Uint8Array): DeepRuntimePackageV5 {
  const parsed = parseDeepRuntimePackage(artifact);
  if (!parsed.valid || parsed.value.schemaVersion !== 5) {
    throw new Error(parsed.valid ? "Dashboard offline archive requires runtime package v5" : parsed.issues[0]?.message ?? "Invalid dashboard runtime artifact");
  }
  const canonical = new TextEncoder().encode(serializeDeepRuntimePackage(parsed.value));
  if (!equalBytes(artifact, canonical)) throw new Error("Dashboard offline archive artifact must use canonical runtime package bytes");
  return parsed.value;
}

function assertAuthority(value: DashboardPublicationAuthorityToken): void {
  if (!value || !value.projectId || !value.applicationId || !value.publicationId
    || !Number.isSafeInteger(value.applicationRevision) || value.applicationRevision < 1) {
    throw new Error("Dashboard offline archive has invalid publication authority");
  }
}
function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} hash must be a lowercase SHA-256`);
}
function snapshot<T>(value: T): T { return structuredClone(value); }
function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
export function dashboardArchiveCanonicalSha256(value: unknown): string { return canonicalSha256(value); }
function canonicalSha256(value: unknown): string { return sha256(new TextEncoder().encode(canonical(value))); }
function canonical(value: unknown): string { return JSON.stringify(sort(value)); }
function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort((value as Record<string, unknown>)[key])]));
  return value;
}
function equal(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
function fontOrder(left: { readonly resourceId: string; readonly sha256: string; readonly faceIndex: number | undefined },
  right: { readonly resourceId: string; readonly sha256: string; readonly faceIndex: number | undefined }): number {
  return left.resourceId.localeCompare(right.resourceId) || (left.faceIndex ?? -1) - (right.faceIndex ?? -1) || left.sha256.localeCompare(right.sha256);
}
