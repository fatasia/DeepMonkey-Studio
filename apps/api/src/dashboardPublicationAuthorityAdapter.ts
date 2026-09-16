import type { PublishedApplicationRecord } from "@bim-studio/contracts";
import type { MetadataStore } from "./metadataStore.js";
import {
  DashboardPublicationStaleError,
  prepareDashboardPublicationFreeze,
  type DashboardFrozenResourceRequest,
  type DashboardPublicationAuthorityState,
  type DashboardPublicationFreezeCandidate,
  type DashboardResolvedDataRequest,
  type DashboardResolvedDataValue,
  type DashboardResolvedResourceValue,
} from "./dashboardPublicationFreeze.js";

export interface DashboardPublicationAuthorityRevalidation {
  readonly readAuthority: (signal?: AbortSignal) => Promise<DashboardPublicationAuthorityState | undefined>;
  readonly resolveData: (request: DashboardResolvedDataRequest, signal?: AbortSignal) => Promise<DashboardResolvedDataValue>;
  readonly readResource: (request: DashboardFrozenResourceRequest, signal?: AbortSignal) => Promise<DashboardResolvedResourceValue>;
}

/** The complete request shape accepted at the API boundary. */
export interface DashboardPublicationAuthorityRequest {
  readonly projectId: string;
  readonly applicationId: string;
  readonly publicationId: string;
  readonly applicationRevision: number;
  readonly entryPageId: string;
}

/**
 * This is a server-owned adapter for data sources and object versions. Its
 * methods are deliberately not part of DashboardPublicationAuthorityRequest:
 * browser values cannot supply a dashboard document, data, resource list, or
 * any hash used by the frozen publication.
 */
export interface DashboardPublicationTrustedInputs {
  derive(
    publication: PublishedApplicationRecord,
    entryPageId: string,
    signal?: AbortSignal,
  ): Promise<{ readonly data: readonly DashboardResolvedDataRequest[]; readonly resources: readonly DashboardFrozenResourceRequest[] }>;
  resolveData(
    authority: DashboardPublicationAuthorityRequest,
    request: DashboardResolvedDataRequest,
    signal?: AbortSignal,
  ): Promise<DashboardResolvedDataValue>;
  readResource(
    authority: DashboardPublicationAuthorityRequest,
    request: DashboardFrozenResourceRequest,
    signal?: AbortSignal,
  ): Promise<DashboardResolvedResourceValue>;
}

export interface DashboardPublicationAuthorityAdapterDependencies {
  readonly store: Pick<MetadataStore,
    "getProject" | "getApplication" | "getApplicationPublicationPointer" | "getPublishedApplication">;
  readonly trustedInputs: DashboardPublicationTrustedInputs;
}

export interface DashboardPublicationAuthorityAdapter {
  prepare(request: unknown, signal?: AbortSignal): Promise<DashboardPublicationFreezeCandidate>;
  /** Supplies only authority-bound read functions for a candidate recheck. */
  revalidation(request: unknown): DashboardPublicationAuthorityRevalidation;
}

/**
 * Converts the five browser-safe authority fields into a frozen dashboard.
 * The JsonStore/Postgres publication pointer and immutable record establish
 * authority; closure derivation and byte reads remain behind a trusted server
 * adapter. A draft save, unpublish, pointer replacement, or resource revision
 * change is surfaced as DashboardPublicationStaleError by the freeze contract.
 */
export function createDashboardPublicationAuthorityAdapter(
  dependencies: DashboardPublicationAuthorityAdapterDependencies,
): DashboardPublicationAuthorityAdapter {
  const readAuthority = async (request: DashboardPublicationAuthorityRequest): Promise<DashboardPublicationAuthorityState | undefined> => {
    const pointer = dependencies.store.getApplicationPublicationPointer(request.applicationId);
    const project = dependencies.store.getProject(request.projectId);
    const application = dependencies.store.getApplication(request.projectId, request.applicationId);
    if (!pointer || !project || !application || pointer.projectId !== request.projectId
      || pointer.activePublicationId !== request.publicationId
      || application.metadata.revision !== request.applicationRevision) return undefined;
    const publication = dependencies.store.getPublishedApplication(pointer.activePublicationId);
    if (!publication || publication.id !== request.publicationId || publication.projectId !== request.projectId
      || publication.applicationId !== request.applicationId || publication.applicationRevision !== request.applicationRevision) return undefined;
    return {
      activePublicationId: pointer.activePublicationId,
      currentApplicationRevision: application.metadata.revision,
      publication: structuredClone(publication),
    };
  };

  const revalidation = (value: unknown): DashboardPublicationAuthorityRevalidation => {
      assertDashboardPublicationAuthorityRequest(value);
      const request = { ...value };
      return Object.freeze({
        readAuthority: (signal?: AbortSignal) => {
          signal?.throwIfAborted();
          return readAuthority(request);
        },
        resolveData: (item: DashboardResolvedDataRequest, signal?: AbortSignal) => dependencies.trustedInputs.resolveData(request, item, signal),
        readResource: (item: DashboardFrozenResourceRequest, signal?: AbortSignal) => dependencies.trustedInputs.readResource(request, item, signal),
      });
    };
  return {
    revalidation,
    async prepare(value: unknown, signal?: AbortSignal): Promise<DashboardPublicationFreezeCandidate> {
      assertDashboardPublicationAuthorityRequest(value);
      const request = value;
      signal?.throwIfAborted();
      const initial = await readAuthority(request);
      if (!initial) throw new DashboardPublicationStaleError("Published dashboard authority is no longer current");
      const closure = await dependencies.trustedInputs.derive(structuredClone(initial.publication), request.entryPageId, signal);
      signal?.throwIfAborted();
      return prepareDashboardPublicationFreeze({
        expected: request,
        entryPageId: request.entryPageId,
        data: structuredClone(closure.data),
        resources: structuredClone(closure.resources),
        ...revalidation(request),
        ...(signal ? { signal } : {}),
      });
    },
  };
}

/** Runtime validation prevents accidental widening when this is registered as an HTTP body. */
export function assertDashboardPublicationAuthorityRequest(value: unknown): asserts value is DashboardPublicationAuthorityRequest {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("Dashboard publication authority request must be a plain object");
  const record = value as Record<string, unknown>;
  const fields = ["projectId", "applicationId", "publicationId", "applicationRevision", "entryPageId"] as const;
  if (Object.keys(record).length !== fields.length || Object.keys(record).some(key => !fields.includes(key as typeof fields[number])))
    throw new Error("Dashboard publication authority request contains unsupported client fields");
  for (const field of ["projectId", "applicationId", "publicationId", "entryPageId"] as const) {
    if (!validId(record[field])) throw new Error(`Dashboard publication ${field} is invalid`);
  }
  if (!Number.isSafeInteger(record.applicationRevision) || (record.applicationRevision as number) < 1)
    throw new Error("Dashboard publication applicationRevision is invalid");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}
