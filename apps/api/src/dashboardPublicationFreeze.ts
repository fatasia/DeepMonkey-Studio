import { createHash } from "node:crypto";
import {
  assertDashboardDocument,
  createDashboardDocument,
  type DashboardDocument,
  type PublishedApplicationRecord,
} from "@bim-studio/contracts";

const HASH = /^[a-f0-9]{64}$/;
const MAX_ITEM_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export interface DashboardPublicationAuthorityToken {
  readonly projectId: string;
  readonly applicationId: string;
  readonly publicationId: string;
  readonly applicationRevision: number;
}

export interface DashboardPublicationAuthorityState {
  readonly activePublicationId: string;
  readonly currentApplicationRevision: number;
  readonly publication: PublishedApplicationRecord;
}

export interface DashboardResolvedDataRequest {
  readonly id: string;
  readonly nodeId: string;
  readonly sourceRevision: string;
}

export interface DashboardResolvedDataValue { readonly sourceRevision: string; readonly value: unknown }
export interface DashboardResolvedResourceValue { readonly revision: number; readonly bytes: Uint8Array }

export interface DashboardFrozenResourceRequest {
  readonly id: string;
  readonly kind: "font" | "image";
  readonly objectKey: string;
  readonly mime: string;
  readonly nodeIds: readonly string[];
  readonly revision: number;
  /** Optional deployment/catalog identity, checked against the bytes actually frozen. */
  readonly expectedSha256?: string;
  readonly faceIndex?: number;
  readonly license?: { readonly redistributable: boolean; readonly evidence: string };
}

export interface DashboardPublicationFreezeManifest {
  readonly schema: "deep-engine.dashboard-publication-freeze";
  readonly schemaVersion: 1;
  readonly authority: DashboardPublicationAuthorityToken;
  readonly entryPageId: string;
  readonly documentSha256: string;
  readonly data: readonly {
    readonly id: string; readonly nodeId: string; readonly sourceRevision: string;
    readonly bytes: number; readonly sha256: string;
  }[];
  readonly resources: readonly {
    readonly id: string; readonly kind: "font" | "image"; readonly objectKey: string;
    readonly mime: string; readonly nodeIds: readonly string[]; readonly revision: number;
    readonly bytes: number; readonly sha256: string; readonly faceIndex?: number;
    readonly licenseEvidence?: string;
  }[];
  readonly totalBytes: number;
  readonly manifestSha256: string;
}

export interface DashboardPublicationFreezeCandidate {
  readonly authority: DashboardPublicationAuthorityToken;
  readonly document: DashboardDocument;
  readonly data: Readonly<Record<string, unknown>>;
  readonly resources: Readonly<Record<string, Uint8Array>>;
  readonly manifest: DashboardPublicationFreezeManifest;
}

export interface PrepareDashboardPublicationFreezeOptions {
  readonly expected: DashboardPublicationAuthorityToken;
  readonly entryPageId: string;
  readonly data: readonly DashboardResolvedDataRequest[];
  readonly resources: readonly DashboardFrozenResourceRequest[];
  readonly readAuthority: (signal?: AbortSignal) => Promise<DashboardPublicationAuthorityState | undefined>;
  readonly resolveData: (request: DashboardResolvedDataRequest, signal?: AbortSignal) => Promise<DashboardResolvedDataValue>;
  readonly readResource: (request: DashboardFrozenResourceRequest, signal?: AbortSignal) => Promise<DashboardResolvedResourceValue>;
  readonly signal?: AbortSignal;
}

export class DashboardPublicationStaleError extends Error {
  override readonly name = "DashboardPublicationStaleError";
}

/** Canonical JSON SHA-256 shared by every frozen dashboard evidence record. */
export function dashboardCanonicalJsonSha256(value: unknown): string {
  return sha256(canonicalBytes(value));
}

export async function prepareDashboardPublicationFreeze(
  options: PrepareDashboardPublicationFreezeOptions,
): Promise<DashboardPublicationFreezeCandidate> {
  options.signal?.throwIfAborted();
  const state = snapshotAuthority(await options.readAuthority(options.signal));
  assertAuthority(state, options.expected);
  const document = createDashboardDocument(state.publication.document, options.entryPageId);
  const nodeIds = new Set(document.application.pages.flatMap((page) => page.nodes.map((node) => node.id)));
  const dataRequests = sortedUnique(options.data, "data binding");
  const resourceRequests = sortedUnique(options.resources, "resource");
  const data: Record<string, unknown> = {}, resources: Record<string, Uint8Array> = {};
  const dataManifest: DashboardPublicationFreezeManifest["data"][number][] = [];
  const resourceManifest: DashboardPublicationFreezeManifest["resources"][number][] = [];
  let totalBytes = 0;

  for (const request of dataRequests) {
    options.signal?.throwIfAborted();
    if (!nodeIds.has(request.nodeId) || !request.sourceRevision) throw new Error(`Resolved data ${request.id} has an invalid node or revision`);
    const resolved = await options.resolveData(structuredClone(request), options.signal);
    options.signal?.throwIfAborted();
    if (resolved.sourceRevision !== request.sourceRevision) throw new DashboardPublicationStaleError(`Resolved data ${request.id} revision changed`);
    const value = structuredClone(resolved.value);
    const bytes = canonicalBytes(value);
    totalBytes = addBytes(totalBytes, bytes.byteLength, request.id);
    data[request.id] = value;
    dataManifest.push({ ...request, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }

  for (const request of resourceRequests) {
    options.signal?.throwIfAborted();
    assertResourceRequest(request, options.expected.projectId, nodeIds);
    const resolved = await options.readResource(structuredClone(request), options.signal);
    options.signal?.throwIfAborted();
    if (resolved.revision !== request.revision) throw new DashboardPublicationStaleError(`Resource ${request.id} revision changed`);
    const bytes = Uint8Array.from(resolved.bytes);
    if (request.expectedSha256 && sha256(bytes) !== request.expectedSha256)
      throw new DashboardPublicationStaleError(`Resource ${request.id} differs from the deployed catalog`);
    totalBytes = addBytes(totalBytes, bytes.byteLength, request.id);
    resources[request.id] = bytes;
    resourceManifest.push({ id: request.id, kind: request.kind, objectKey: request.objectKey, mime: request.mime,
      nodeIds: [...new Set(request.nodeIds)].sort(), revision: request.revision, bytes: bytes.byteLength,
      sha256: sha256(bytes), ...(request.faceIndex === undefined ? {} : { faceIndex: request.faceIndex }),
      ...(request.license ? { licenseEvidence: request.license.evidence } : {}) });
  }

  const manifestBody = { schema: "deep-engine.dashboard-publication-freeze" as const, schemaVersion: 1 as const,
    authority: { ...options.expected }, entryPageId: options.entryPageId,
    documentSha256: sha256(canonicalBytes(document)), data: dataManifest, resources: resourceManifest, totalBytes };
  const manifest: DashboardPublicationFreezeManifest = { ...manifestBody, manifestSha256: sha256(canonicalBytes(manifestBody)) };
  const finalState = snapshotAuthority(await options.readAuthority(options.signal));
  assertAuthority(finalState, options.expected);
  assertPublishedDocument(finalState, document);
  options.signal?.throwIfAborted();
  return { authority: { ...options.expected }, document, data, resources, manifest };
}

export async function assertDashboardPublicationFreezeCommit(candidate: DashboardPublicationFreezeCandidate, options: {
  readonly readAuthority: (signal?: AbortSignal) => Promise<DashboardPublicationAuthorityState | undefined>;
  readonly resolveData: (request: DashboardResolvedDataRequest, signal?: AbortSignal) => Promise<DashboardResolvedDataValue>;
  readonly readResource: (request: DashboardFrozenResourceRequest, signal?: AbortSignal) => Promise<DashboardResolvedResourceValue>;
  readonly signal?: AbortSignal;
}): Promise<void> {
  options.signal?.throwIfAborted();
  assertCandidateIntegrity(candidate);
  const state = snapshotAuthority(await options.readAuthority(options.signal));
  assertAuthority(state, candidate.authority);
  assertPublishedDocument(state, candidate.document);
  for (const item of candidate.manifest.data) {
    options.signal?.throwIfAborted();
    const resolved = await options.resolveData(
      { id: item.id, nodeId: item.nodeId, sourceRevision: item.sourceRevision }, options.signal);
    options.signal?.throwIfAborted();
    if (resolved.sourceRevision !== item.sourceRevision) throw new DashboardPublicationStaleError(`Resolved data ${item.id} revision changed before commit`);
    const current = canonicalBytes(resolved.value);
    if (current.byteLength !== item.bytes || sha256(current) !== item.sha256)
      throw new DashboardPublicationStaleError(`Resolved data ${item.id} changed before commit`);
  }
  for (const item of candidate.manifest.resources) {
    options.signal?.throwIfAborted();
    const request: DashboardFrozenResourceRequest = { id: item.id, kind: item.kind, objectKey: item.objectKey,
      mime: item.mime, nodeIds: item.nodeIds, revision: item.revision,
      ...(item.faceIndex === undefined ? {} : { faceIndex: item.faceIndex }),
      ...(item.licenseEvidence === undefined ? {} : { license: { redistributable: true, evidence: item.licenseEvidence } }) };
    const resolved = await options.readResource(request, options.signal);
    options.signal?.throwIfAborted();
    if (resolved.revision !== item.revision || resolved.bytes.byteLength !== item.bytes || sha256(resolved.bytes) !== item.sha256)
      throw new DashboardPublicationStaleError(`Resource ${item.id} changed before commit`);
  }
  // 资源读取期间仍可能保存草稿；结束时必须重新确认发布身份及候选自身。
  options.signal?.throwIfAborted();
  const finalState = snapshotAuthority(await options.readAuthority(options.signal));
  options.signal?.throwIfAborted();
  assertCandidateIntegrity(candidate);
  assertAuthority(finalState, candidate.authority);
  assertPublishedDocument(finalState, candidate.document);
}

function snapshotAuthority(state: DashboardPublicationAuthorityState | undefined): DashboardPublicationAuthorityState {
  if (!state) throw new DashboardPublicationStaleError("Published application is no longer active");
  return structuredClone(state);
}

function assertAuthority(state: DashboardPublicationAuthorityState, expected: DashboardPublicationAuthorityToken): void {
  const publication = state.publication;
  if (state.activePublicationId !== expected.publicationId || state.currentApplicationRevision !== expected.applicationRevision
    || publication.id !== expected.publicationId || publication.projectId !== expected.projectId
    || publication.applicationId !== expected.applicationId || publication.applicationRevision !== expected.applicationRevision
    || publication.document.metadata.id !== expected.applicationId
    || publication.document.metadata.projectId !== expected.projectId
    || publication.document.metadata.revision !== expected.applicationRevision) {
    throw new DashboardPublicationStaleError("Published application authority changed during dashboard compilation");
  }
}

function assertPublishedDocument(state: DashboardPublicationAuthorityState, expected: DashboardDocument): void {
  if (sha256(canonicalBytes(state.publication.document)) !== sha256(canonicalBytes(expected.application))) {
    throw new DashboardPublicationStaleError("Published application document changed without a new revision");
  }
}

function assertResourceRequest(request: DashboardFrozenResourceRequest, projectId: string, nodeIds: ReadonlySet<string>): void {
  if (request.expectedSha256 !== undefined && !HASH.test(request.expectedSha256)) throw new Error(`Resource ${request.id} has an invalid expected hash`);
  if (!validId(request.id) || !request.objectKey.startsWith(`projects/${projectId}/`) || /[?#]/.test(request.objectKey)
    || request.objectKey.split("/").some((part) => !validObjectSegment(part))) throw new Error(`Resource ${request.id} has an invalid private object key`);
  if (!Number.isSafeInteger(request.revision) || request.revision < 1 || !request.nodeIds.length
    || request.nodeIds.some((id) => !nodeIds.has(id))) throw new Error(`Resource ${request.id} has an invalid revision or consumer`);
  if ((request.kind === "font" && !/^font\//.test(request.mime)) || (request.kind === "image" && !/^image\//.test(request.mime)))
    throw new Error(`Resource ${request.id} MIME does not match its kind`);
  if (request.kind === "font" && (!request.license?.redistributable || !request.license.evidence
    || !Number.isSafeInteger(request.faceIndex) || request.faceIndex! < 0)) throw new Error(`Font ${request.id} is not licensed and indexed for publication`);
  if (request.kind === "image" && request.faceIndex !== undefined) throw new Error(`Image ${request.id} cannot declare a font face`);
}

function assertCandidateIntegrity(candidate: DashboardPublicationFreezeCandidate): void {
  assertDashboardDocument(candidate.document);
  if (candidate.manifest.schema !== "deep-engine.dashboard-publication-freeze" || candidate.manifest.schemaVersion !== 1
    || canonicalText(candidate.authority) !== canonicalText(candidate.manifest.authority)
    || candidate.manifest.entryPageId !== candidate.document.entryPageId
    || candidate.document.application.metadata.id !== candidate.authority.applicationId
    || candidate.document.application.metadata.projectId !== candidate.authority.projectId
    || candidate.document.application.metadata.revision !== candidate.authority.applicationRevision) {
    throw new Error("Frozen dashboard authority was modified");
  }
  if (sha256(canonicalBytes(candidate.document)) !== candidate.manifest.documentSha256) throw new Error("Frozen dashboard document was modified");
  const dataIds = candidate.manifest.data.map((item) => item.id), resourceIds = candidate.manifest.resources.map((item) => item.id);
  if (new Set(dataIds).size !== dataIds.length || new Set(resourceIds).size !== resourceIds.length
    || canonicalText(Object.keys(candidate.data).sort()) !== canonicalText([...dataIds].sort())
    || canonicalText(Object.keys(candidate.resources).sort()) !== canonicalText([...resourceIds].sort())) {
    throw new Error("Frozen dashboard closure was modified");
  }
  let totalBytes = 0;
  for (const item of candidate.manifest.data) {
    const bytes = canonicalBytes(candidate.data[item.id]);
    if (bytes.byteLength !== item.bytes || sha256(bytes) !== item.sha256) throw new Error(`Frozen data ${item.id} was modified`);
    totalBytes += bytes.byteLength;
  }
  for (const item of candidate.manifest.resources) {
    const bytes = candidate.resources[item.id];
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== item.bytes || sha256(bytes) !== item.sha256)
      throw new Error(`Frozen resource ${item.id} was modified`);
    totalBytes += bytes.byteLength;
  }
  if (totalBytes !== candidate.manifest.totalBytes) throw new Error("Frozen dashboard byte accounting was modified");
  const { manifestSha256, ...body } = candidate.manifest;
  if (!HASH.test(manifestSha256) || sha256(canonicalBytes(body)) !== manifestSha256) throw new Error("Dashboard freeze manifest was modified");
}

function sortedUnique<T extends { readonly id: string }>(items: readonly T[], label: string): T[] {
  const copy: T[] = structuredClone([...items]);
  copy.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  if (copy.some((item, index) => !validId(item.id) || item.id === copy[index - 1]?.id)) throw new Error(`Duplicate or invalid ${label} id`);
  return copy;
}

function validId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value); }

function validObjectSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !/[<>:"\\|?*%\u0000-\u001f\u007f]/.test(value)
    && !/[. ]$/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}

function addBytes(total: number, size: number, id: string): number {
  if (size < 1 || size > MAX_ITEM_BYTES) throw new Error(`Frozen item ${id} exceeds its byte budget`);
  const next = total + size;
  if (next > MAX_TOTAL_BYTES) throw new Error("Dashboard frozen resource byte budget exceeded");
  return next;
}

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

function canonicalText(value: unknown): string { return new TextDecoder().decode(canonicalBytes(value)); }

function canonicalBytes(value: unknown): Uint8Array {
  const ancestors = new Set<object>();
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") { if (!Number.isFinite(item)) throw new Error("Frozen JSON contains a non-finite number"); return item; }
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length
        || !Array.from({ length: item.length }, (_value, index) => Object.hasOwn(item, index)).every(Boolean))
        throw new Error("Frozen JSON contains a sparse array or extra property");
      if (ancestors.has(item)) throw new Error("Frozen JSON contains a cycle");
      ancestors.add(item); const result = item.map(visit); ancestors.delete(item); return result;
    }
    if (!item || typeof item !== "object" || Object.getPrototypeOf(item) !== Object.prototype) throw new Error("Frozen value is not canonical JSON");
    if (ancestors.has(item)) throw new Error("Frozen JSON contains a cycle");
    ancestors.add(item);
    const result = Object.fromEntries(Object.keys(item).sort().map((key) => {
      const child = (item as Record<string, unknown>)[key];
      if (child === undefined) throw new Error("Frozen JSON contains undefined");
      return [key, visit(child)];
    }));
    ancestors.delete(item); return result;
  };
  return new TextEncoder().encode(JSON.stringify(visit(value)));
}
