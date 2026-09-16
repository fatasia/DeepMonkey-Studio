import { createHash } from "node:crypto";
import {
  parseDeepRuntimePackage,
  serializeDeepRuntimePackage,
  type DeepRuntimePackageV5,
} from "@bim-studio/deep-engine/runtime-package";
import {
  assertDashboardPublicationFreezeCommit,
  type DashboardPublicationAuthorityState,
  type DashboardPublicationFreezeCandidate,
  type DashboardResolvedDataRequest,
  type DashboardResolvedDataValue,
  type DashboardFrozenResourceRequest,
  type DashboardResolvedResourceValue,
} from "./dashboardPublicationFreeze.js";
import type { DashboardPublicationCapabilityReport } from "./dashboardPublicationCapability.js";

const SHA256 = /^[a-f0-9]{64}$/;

/** The worker receives only frozen bytes and the authority that selected them. */
export interface DashboardRuntimeArtifactCompilerInput {
  readonly protocol: "dashboard-runtime-compiler-v1";
  readonly authority: DashboardPublicationFreezeCandidate["authority"];
  readonly freezeManifestSha256: string;
  readonly freezeManifest?: DashboardPublicationFreezeCandidate["manifest"];
  readonly sourceSemanticHash: string;
  readonly compileGraphHash: string;
  readonly compiler: { readonly id: string; readonly version: string; readonly sha256: string; readonly configuration: Readonly<Record<string, unknown>> };
  readonly document: DashboardPublicationFreezeCandidate["document"];
  readonly data: Readonly<Record<string, unknown>>;
  readonly resources: Readonly<Record<string, Uint8Array>>;
}

/** A C5 worker cannot choose a different package format or report its own hashes. */
export interface DashboardRuntimeArtifactCompilerOutput {
  readonly protocol: "dashboard-runtime-compiler-v1";
  readonly authority: DashboardPublicationFreezeCandidate["authority"];
  readonly freezeManifestSha256: string;
  readonly sourceSemanticHash: string;
  readonly compileGraphHash: string;
  readonly artifact: Uint8Array;
}

export interface PrepareDashboardRuntimeArtifactCompilerOptions {
  readonly candidate: DashboardPublicationFreezeCandidate;
  readonly capability: DashboardPublicationCapabilityReport;
  readonly compiler: DashboardRuntimeArtifactCompilerInput["compiler"];
  readonly revalidation: DashboardFreezeRevalidation;
  readonly signal?: AbortSignal;
}

export interface DashboardFreezeRevalidation {
  readonly readAuthority: (signal?: AbortSignal) => Promise<DashboardPublicationAuthorityState | undefined>;
  readonly resolveData: (request: DashboardResolvedDataRequest, signal?: AbortSignal) => Promise<DashboardResolvedDataValue>;
  readonly readResource: (request: DashboardFrozenResourceRequest, signal?: AbortSignal) => Promise<DashboardResolvedResourceValue>;
}

export interface VerifiedDashboardRuntimeArtifact {
  readonly artifact: Uint8Array;
  readonly artifactSha256: string;
  readonly runtimePackage: DeepRuntimePackageV5;
  readonly authority: DashboardPublicationFreezeCandidate["authority"];
  readonly freezeManifestSha256: string;
  readonly sourceSemanticHash: string;
  readonly compileGraphHash: string;
}

/**
 * C5's adapter boundary. It rechecks C3 authority before a worker starts and
 * freezes both byte payloads and compiler metadata so the worker gets no live
 * storage handles and no ability to change C4's semantic identity.
 */
export async function prepareDashboardRuntimeArtifactCompilerInput(
  options: PrepareDashboardRuntimeArtifactCompilerOptions,
): Promise<DashboardRuntimeArtifactCompilerInput> {
  options.signal?.throwIfAborted();
  await assertDashboardPublicationFreezeCommit(options.candidate, { ...options.revalidation,
    ...(options.signal ? { signal: options.signal } : {}) });
  options.signal?.throwIfAborted();
  assertCapability(options.candidate, options.capability, options.compiler);
  return Object.freeze({
    protocol: "dashboard-runtime-compiler-v1",
    authority: snapshot(options.candidate.authority),
    freezeManifestSha256: options.candidate.manifest.manifestSha256,
    freezeManifest: snapshot(options.candidate.manifest),
    sourceSemanticHash: options.capability.sourceSemanticHash,
    compileGraphHash: options.capability.compileGraphHash,
    compiler: freezeCompiler(options.compiler),
    document: snapshot(options.candidate.document),
    data: snapshot(options.candidate.data),
    resources: freezeResources(options.candidate.resources),
  });
}

/**
 * Accept only the exact C4-proven artifact. This is intentionally separate
 * from worker transport: a child process may serialize bytes, but may not
 * mint authority, hashes, or a non-v5 runtime package.
 */
export function acceptDashboardRuntimeArtifactCompilerOutput(
  input: DashboardRuntimeArtifactCompilerInput,
  output: DashboardRuntimeArtifactCompilerOutput,
  capability: DashboardPublicationCapabilityReport,
): VerifiedDashboardRuntimeArtifact {
  assertInput(input);
  assertCapabilityIdentity(input, capability);
  if (output.protocol !== input.protocol || !equal(output.authority, input.authority)
    || output.freezeManifestSha256 !== input.freezeManifestSha256
    || output.sourceSemanticHash !== input.sourceSemanticHash || output.compileGraphHash !== input.compileGraphHash) {
    throw new Error("Dashboard compiler output is not bound to the frozen authority and compile graph");
  }
  if (!(output.artifact instanceof Uint8Array) || output.artifact.byteLength < 1) {
    throw new Error("Dashboard compiler returned no runtime artifact bytes");
  }
  const artifact = Uint8Array.from(output.artifact);
  const parsed = parseDeepRuntimePackage(artifact);
  if (!parsed.valid || parsed.value.schemaVersion !== 5) {
    throw new Error(parsed.valid ? "Dashboard compiler must return runtime package v5" : parsed.issues[0]?.message ?? "Invalid dashboard runtime artifact");
  }
  const canonical = new TextEncoder().encode(serializeDeepRuntimePackage(parsed.value));
  if (!equalBytes(artifact, canonical)) throw new Error("Dashboard runtime artifact must use canonical package bytes");
  const artifactSha256 = sha256(artifact);
  if (artifactSha256 !== capability.targetArtifactHash) {
    throw new Error("Dashboard runtime artifact bytes differ from C4 verified target");
  }
  return Object.freeze({ artifact, artifactSha256, runtimePackage: parsed.value,
    authority: snapshot(input.authority), freezeManifestSha256: input.freezeManifestSha256,
    sourceSemanticHash: input.sourceSemanticHash, compileGraphHash: input.compileGraphHash });
}

function assertCapability(candidate: DashboardPublicationFreezeCandidate, capability: DashboardPublicationCapabilityReport,
  compiler: DashboardRuntimeArtifactCompilerInput["compiler"]): void {
  assertCompiler(compiler);
  if (capability.schema !== "deep-engine.dashboard-publication-capability" || capability.schemaVersion !== 1
    || !equal(capability.authority, candidate.authority)
    || capability.freezeManifestSha256 !== candidate.manifest.manifestSha256
    || capability.compiler.id !== compiler.id || capability.compiler.version !== compiler.version
    || capability.compiler.sha256 !== compiler.sha256
    || capability.compiler.configurationSha256 !== canonicalSha256(compiler.configuration)) {
    throw new Error("Dashboard capability report is not bound to this frozen candidate and compiler");
  }
  assertHash(capability.sourceSemanticHash, "Dashboard source semantic hash");
  assertHash(capability.compileGraphHash, "Dashboard compile graph hash");
  assertHash(capability.targetArtifactHash, "Dashboard target artifact hash");
}

function assertCapabilityIdentity(input: DashboardRuntimeArtifactCompilerInput, capability: DashboardPublicationCapabilityReport): void {
  assertCapability({ authority: input.authority, manifest: { manifestSha256: input.freezeManifestSha256 } } as DashboardPublicationFreezeCandidate,
    capability, input.compiler);
  if (capability.sourceSemanticHash !== input.sourceSemanticHash || capability.compileGraphHash !== input.compileGraphHash) {
    throw new Error("Dashboard capability report identity changed after compiler preparation");
  }
}

function assertInput(input: DashboardRuntimeArtifactCompilerInput): void {
  if (input.protocol !== "dashboard-runtime-compiler-v1") throw new Error("Unsupported dashboard compiler protocol");
  assertCompiler(input.compiler); assertHash(input.freezeManifestSha256, "Dashboard freeze manifest hash");
  assertHash(input.sourceSemanticHash, "Dashboard source semantic hash"); assertHash(input.compileGraphHash, "Dashboard compile graph hash");
}
function assertCompiler(compiler: DashboardRuntimeArtifactCompilerInput["compiler"]): void {
  if (!compiler.id || !compiler.version || !SHA256.test(compiler.sha256)) throw new Error("Dashboard compiler deployment identity is invalid");
  canonicalSha256(compiler.configuration);
}
function assertHash(value: string, label: string): void { if (!SHA256.test(value)) throw new Error(`${label} must be a SHA-256`); }
function freezeCompiler(value: DashboardRuntimeArtifactCompilerInput["compiler"]): DashboardRuntimeArtifactCompilerInput["compiler"] {
  return Object.freeze({ id: value.id, version: value.version, sha256: value.sha256, configuration: snapshot(value.configuration) });
}
function freezeResources(value: Readonly<Record<string, Uint8Array>>): Readonly<Record<string, Uint8Array>> {
  return Object.freeze(Object.fromEntries(Object.keys(value).sort().map(key => [key, Uint8Array.from(value[key]!)])));
}
function snapshot<T>(value: T): T { return structuredClone(value); }
function equal(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }
function canonical(value: unknown): string { return JSON.stringify(sort(value)); }
function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort((value as Record<string, unknown>)[key])]));
  return value;
}
function canonicalSha256(value: unknown): string { return sha256(new TextEncoder().encode(canonical(value))); }
function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}
