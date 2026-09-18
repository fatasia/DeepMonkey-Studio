import { createHash } from "node:crypto";
import {
  assertDashboardPublicationFreezeCommit,
  type DashboardPublicationFreezeCandidate,
  type DashboardResolvedDataRequest,
  type DashboardResolvedDataValue,
  type DashboardFrozenResourceRequest,
  type DashboardResolvedResourceValue,
  type DashboardPublicationAuthorityState,
} from "./dashboardPublicationFreeze.js";

const SHA256 = /^[a-f0-9]{64}$/;

export interface DashboardCompiledWindowEvidence {
  readonly backgroundBindings?: readonly { readonly authorPageId: string; readonly pageId: string;
    readonly resourceId: string; readonly sourceSha256: string; readonly atlasId: string; readonly pixelSha256: string }[];
  readonly nodeBindings: readonly { readonly nodeId: string; readonly runtimeNodeId: string;
    readonly pageId: string; readonly staticResourceId: string | null }[];
  readonly fontBindings: readonly { readonly resourceId: string; readonly sha256: string;
    readonly faceIndex: number; readonly runtimeNodeId: string; readonly atlasId: string }[];
}

/** A compiler result is accepted only through this server-owned callback. */
export interface AuthoritativeDashboardCompiler {
  readonly compilerId: string;
  readonly compilerVersion: string;
  /** SHA-256 of the deployed compiler bytes, never a worker-supplied label. */
  readonly compilerSha256: string;
  readonly configuration: Readonly<Record<string, unknown>>;
  compile(input: {
    readonly document: DashboardPublicationFreezeCandidate["document"];
    readonly data: Readonly<Record<string, unknown>>;
    readonly resources: Readonly<Record<string, Uint8Array>>;
    readonly freezeManifest?: DashboardPublicationFreezeCandidate["manifest"];
  }, signal?: AbortSignal): Promise<{
    readonly artifact: Uint8Array;
    readonly windowEvidence?: DashboardCompiledWindowEvidence;
    readonly objects: readonly { readonly nodeId: string; readonly contentCompiled: boolean; readonly deferredFields: readonly string[] }[];
  }>;
}

/** Produced by the Native/window verifier, never by the dashboard browser. */
export interface DashboardWindowVerification {
  readonly verifier: "native-dashboard-window-v1";
  readonly authority: DashboardPublicationFreezeCandidate["authority"];
  readonly freezeManifestSha256: string;
  readonly sourceSemanticHash: string;
  readonly compileGraphHash: string;
  readonly targetArtifactHash: string;
  readonly fixtureSha256: string;
  readonly deviceFingerprintSha256: string;
  readonly fontSha256: readonly { readonly resourceId: string; readonly sha256: string; readonly faceIndex: number }[];
  readonly renderedNodeIds: readonly string[];
}

export interface DashboardPublicationCapabilityReport {
  readonly schema: "deep-engine.dashboard-publication-capability";
  readonly schemaVersion: 1;
  readonly authority: DashboardPublicationFreezeCandidate["authority"];
  readonly freezeManifestSha256: string;
  readonly sourceSemanticHash: string;
  readonly compileGraphHash: string;
  readonly targetArtifactHash: string;
  readonly compiler: { readonly id: string; readonly version: string; readonly sha256: string; readonly configurationSha256: string };
  readonly evidence: Pick<DashboardWindowVerification, "verifier" | "fixtureSha256" | "deviceFingerprintSha256" | "fontSha256">;
  readonly objects: readonly { readonly nodeId: string; readonly status: "supported" | "degraded" | "blocked"; readonly deferredFields: readonly string[] }[];
}

export interface BuildDashboardPublicationCapabilityOptions {
  readonly candidate: DashboardPublicationFreezeCandidate;
  readonly compiler: AuthoritativeDashboardCompiler;
  readonly expectedDeviceFingerprintSha256: string;
  readonly revalidation: {
    readonly readAuthority: (signal?: AbortSignal) => Promise<DashboardPublicationAuthorityState | undefined>;
    readonly resolveData: (request: DashboardResolvedDataRequest, signal?: AbortSignal) => Promise<DashboardResolvedDataValue>;
    readonly readResource: (request: DashboardFrozenResourceRequest, signal?: AbortSignal) => Promise<DashboardResolvedResourceValue>;
  };
  /** This callback must run in the trusted server verifier boundary. */
  readonly verifyWindow: (input: {
    readonly artifact: Uint8Array;
    readonly windowEvidence?: DashboardCompiledWindowEvidence;
    readonly candidate: DashboardPublicationFreezeCandidate;
    readonly sourceSemanticHash: string;
    readonly compileGraphHash: string;
    readonly targetArtifactHash: string;
  }, signal?: AbortSignal) => Promise<DashboardWindowVerification>;
  /** C4 必须与 C5 worker 编译同一份语义输入:调用方绑定一次后把同一份测量数据传给两侧。 */
  readonly boundData?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

/**
 * Builds the P0-04 report from frozen inputs, compiler bytes and a verifier receipt.
 * There is deliberately no client capability/report parameter: a browser declaration
 * cannot turn an object into supported.
 */
export async function buildDashboardPublicationCapabilityReport(options: BuildDashboardPublicationCapabilityOptions): Promise<DashboardPublicationCapabilityReport> {
  const { candidate, signal } = options;
  signal?.throwIfAborted();
  assertSha(options.expectedDeviceFingerprintSha256, "Expected device fingerprint");
  await assertDashboardPublicationFreezeCommit(candidate, { ...options.revalidation,
    ...(signal ? { signal } : {}) });
  signal?.throwIfAborted();

  const sourceSemanticHash = hashCanonical({ kind: "dashboard-source-v1", authority: candidate.authority,
    freezeManifestSha256: candidate.manifest.manifestSha256 });
  const compiler = { id: options.compiler.compilerId, version: options.compiler.compilerVersion, sha256: options.compiler.compilerSha256,
    configurationSha256: hashCanonical(options.compiler.configuration) };
  if (!compiler.id || !compiler.version || !SHA256.test(compiler.sha256)) throw new Error("Authoritative dashboard compiler identity is required");
  const compileGraphHash = hashCanonical({ kind: "dashboard-compile-v1", sourceSemanticHash, compiler });
  const compiled = await options.compiler.compile({ document: candidate.document,
    data: options.boundData ?? candidate.data,
    resources: candidate.resources, freezeManifest: structuredClone(candidate.manifest) }, signal);
  if (process.env.DEEP_ARTIFACT_DUMP) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${process.env.DEEP_ARTIFACT_DUMP}.capability`, compiled.artifact);
  }
  signal?.throwIfAborted();
  if (!(compiled.artifact instanceof Uint8Array) || compiled.artifact.byteLength < 1) throw new Error("Dashboard compiler returned no artifact bytes");
  const windowEvidence = compiled.windowEvidence ? structuredClone(compiled.windowEvidence) : undefined;
  const targetArtifactHash = sha256(compiled.artifact);
  await assertDashboardPublicationFreezeCommit(candidate, { ...options.revalidation,
    ...(signal ? { signal } : {}) });
  signal?.throwIfAborted();

  const verification = await options.verifyWindow({ artifact: Uint8Array.from(compiled.artifact), candidate,
    ...(windowEvidence ? { windowEvidence: structuredClone(windowEvidence) } : {}),
    sourceSemanticHash, compileGraphHash, targetArtifactHash }, signal);
  signal?.throwIfAborted();
  const missingFontNodes = assertWindowVerification(verification, candidate, sourceSemanticHash, compileGraphHash, targetArtifactHash,
    options.expectedDeviceFingerprintSha256, windowEvidence);
  const rendered = new Set(verification.renderedNodeIds);
  const authoredIds = new Set(candidate.document.application.pages.flatMap(page => page.nodes.map(node => node.id)));
  const objectIds = new Set<string>();
  const objects = compiled.objects.map(object => {
    if (!object.nodeId || objectIds.has(object.nodeId)) throw new Error("Compiler returned duplicate or invalid dashboard object identity");
    if (!authoredIds.has(object.nodeId)) throw new Error(`Compiler returned unknown dashboard object ${object.nodeId}`);
    objectIds.add(object.nodeId);
    return { nodeId: object.nodeId,
      status: object.contentCompiled && rendered.has(object.nodeId) && !missingFontNodes.has(object.nodeId)
        && object.deferredFields.length === 0 ? "supported" as const
        : object.contentCompiled ? "degraded" as const : "blocked" as const,
      deferredFields: [...new Set(object.deferredFields)].sort() };
  });
  for (const nodeId of rendered) if (!objectIds.has(nodeId)) throw new Error(`Verifier attested an unknown dashboard object ${nodeId}`);
  // 编译器遗漏对象也必须出现在报告中，不能使部分页面看起来已全部支持。
  for (const nodeId of authoredIds) {
    if (!objectIds.has(nodeId)) objects.push({ nodeId, status: "blocked", deferredFields: ["$"] });
  }
  return { schema: "deep-engine.dashboard-publication-capability", schemaVersion: 1, authority: { ...candidate.authority },
    freezeManifestSha256: candidate.manifest.manifestSha256, sourceSemanticHash, compileGraphHash, targetArtifactHash,
    compiler, evidence: { verifier: verification.verifier, fixtureSha256: verification.fixtureSha256,
      deviceFingerprintSha256: verification.deviceFingerprintSha256, fontSha256: normalizedFonts(verification.fontSha256) }, objects };
}

function assertWindowVerification(verification: DashboardWindowVerification, candidate: DashboardPublicationFreezeCandidate,
  sourceSemanticHash: string, compileGraphHash: string, targetArtifactHash: string, expectedDevice: string,
  windowEvidence?: DashboardCompiledWindowEvidence): ReadonlySet<string> {
  if (verification.verifier !== "native-dashboard-window-v1"
    || canonical(verification.authority) !== canonical(candidate.authority)
    || verification.freezeManifestSha256 !== candidate.manifest.manifestSha256
    || verification.sourceSemanticHash !== sourceSemanticHash || verification.compileGraphHash !== compileGraphHash
    || verification.targetArtifactHash !== targetArtifactHash || verification.deviceFingerprintSha256 !== expectedDevice) {
    throw new Error("Dashboard verifier evidence is not bound to this publication, compilation, artifact, or device");
  }
  assertSha(verification.fixtureSha256, "Verifier fixture");
  assertSha(verification.deviceFingerprintSha256, "Verifier device fingerprint");
  const expectedFonts = candidate.manifest.resources.filter(item => item.kind === "font")
    .map(item => ({ resourceId: item.id, sha256: item.sha256, faceIndex: item.faceIndex! }));
  if (!windowEvidence && canonical(normalizedFonts(verification.fontSha256)) !== canonical(normalizedFonts(expectedFonts)))
    throw new Error("Dashboard verifier font evidence is not the frozen font closure");
  if (new Set(verification.renderedNodeIds).size !== verification.renderedNodeIds.length)
    throw new Error("Dashboard verifier repeated an object identity");
  return windowEvidence ? missingVerifiedFonts(verification, candidate, windowEvidence) : new Set();
}

/** Frozen fallback and other-page fonts need not be used; actual used fonts remain node-bound. */
function missingVerifiedFonts(verification: DashboardWindowVerification, candidate: DashboardPublicationFreezeCandidate,
  evidence: DashboardCompiledWindowEvidence): ReadonlySet<string> {
  const authored = new Set(candidate.document.application.pages.flatMap(page => page.nodes.map(node => node.id)));
  const bindings = new Map<string, DashboardCompiledWindowEvidence["nodeBindings"][number]>();
  const boundAuthors = new Set<string>();
  for (const binding of evidence.nodeBindings) {
    if (!authored.has(binding.nodeId) || !binding.runtimeNodeId || !binding.pageId
      || (binding.staticResourceId !== null && (typeof binding.staticResourceId !== "string" || !binding.staticResourceId))
      || bindings.has(binding.runtimeNodeId)) throw new Error("Invalid compiler font node binding");
    bindings.set(binding.runtimeNodeId, binding); boundAuthors.add(binding.nodeId);
  }
  const rendered = new Set(verification.renderedNodeIds);
  for (const id of rendered) if (!boundAuthors.has(id)) throw new Error("Rendered node lacks compiler font binding");
  const key = (font: { resourceId: string; sha256: string; faceIndex: number }) =>
    canonical([font.resourceId, font.sha256, font.faceIndex]);
  const required = new Map<string, Set<string>>(), permitted = new Set<string>();
  for (const font of evidence.fontBindings) {
    normalizedFonts([font]);
    const binding = bindings.get(font.runtimeNodeId);
    const frozen = candidate.manifest.resources.find(resource => resource.id === font.resourceId && resource.kind === "font");
    if (!binding?.staticResourceId || !font.atlasId || !frozen || frozen.sha256 !== font.sha256 || frozen.faceIndex !== font.faceIndex
      || !frozen.nodeIds.includes(binding.nodeId)) throw new Error("Compiler font evidence is outside the frozen font closure");
    const fonts = required.get(binding.nodeId) ?? new Set<string>();
    fonts.add(key(font)); required.set(binding.nodeId, fonts);
    if (rendered.has(binding.nodeId)) permitted.add(key(font));
  }
  const verified = new Set<string>();
  for (const font of normalizedFonts(verification.fontSha256)) {
    const identity = key(font);
    if (verified.has(identity) || !permitted.has(identity)) throw new Error("Verifier font evidence is not compiler-bound rendered coverage");
    verified.add(identity);
  }
  return new Set([...required].filter(([, fonts]) => [...fonts].some(font => !verified.has(font))).map(([id]) => id));
}

function normalizedFonts(fonts: readonly { readonly resourceId: string; readonly sha256: string; readonly faceIndex: number }[]) {
  return [...fonts].map(font => { if (!font.resourceId || !Number.isSafeInteger(font.faceIndex) || font.faceIndex < 0) throw new Error("Invalid verifier font identity"); assertSha(font.sha256, "Verifier font hash"); return { ...font }; })
    .sort((left, right) => left.resourceId.localeCompare(right.resourceId) || left.faceIndex - right.faceIndex || left.sha256.localeCompare(right.sha256));
}

function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function hashCanonical(value: unknown): string { return sha256(new TextEncoder().encode(canonical(value))); }
function canonical(value: unknown): string { return JSON.stringify(sort(value)); }
function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort((value as Record<string, unknown>)[key])]));
  return value;
}
function assertSha(value: string, label: string): void { if (!SHA256.test(value)) throw new Error(`${label} must be a SHA-256`); }
