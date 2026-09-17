import { randomUUID } from "node:crypto";
import type { DashboardNativeCandidate } from "./dashboardNativeCandidateService.js";

const DEFAULT_TTL_MS = 15 * 60 * 1_000;

/** The only fields a route may return after candidate registration. */
export interface DashboardNativeCandidateSummary {
  readonly candidateId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly authority: DashboardNativeCandidate["authority"];
  readonly freezeManifestSha256: string;
  readonly sourceSemanticHash: string;
  readonly compileGraphHash: string;
  readonly targetArtifactHash: string;
  readonly artifactSha256: string;
}

/** Route lookup scope. Browser callers never send an artifact, document, resource, or hash. */
export interface DashboardNativeCandidateLookup {
  readonly candidateId: string;
  readonly projectId: string;
  readonly applicationId: string;
}

/** Server-only record; its artifact bytes are never included in the summary. */
export interface DashboardNativeCandidateRecord {
  readonly summary: DashboardNativeCandidateSummary;
  readonly candidate: DashboardNativeCandidate;
}

/**
 * Persistence port for C5. Production storage may implement this with object
 * references; the supplied implementation keeps immutable copies in memory.
 */
export interface DashboardNativeCandidateRecordStore {
  save(record: DashboardNativeCandidateRecord): void;
  load(candidateId: string): DashboardNativeCandidateRecord | undefined;
  remove(candidateId: string): void;
}

export interface DashboardNativeCandidateRegistryOptions {
  readonly store?: DashboardNativeCandidateRecordStore;
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly createId?: () => string;
}

export interface DashboardNativeCandidateRegistry {
  register(candidate: DashboardNativeCandidate): DashboardNativeCandidateSummary;
  read(lookup: unknown): DashboardNativeCandidateRecord;
  remove(candidateId: string): void;
}

/**
 * Registers only candidates returned by the trusted C5 service. The record
 * survives replacement of that service's single in-flight value, while the
 * byte payload remains server-side for archive/download adapters.
 */
export function createDashboardNativeCandidateRegistry(
  options: DashboardNativeCandidateRegistryOptions = {},
): DashboardNativeCandidateRegistry {
  const now = options.now ?? Date.now;
  const store = options.store ?? createInMemoryDashboardNativeCandidateRecordStore(now);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 24 * 60 * 60 * 1_000) {
    throw new Error("Dashboard candidate TTL must be between 1 ms and 24 hours");
  }
  const createId = options.createId ?? randomUUID;

  return Object.freeze({
    register(candidate: DashboardNativeCandidate): DashboardNativeCandidateSummary {
      const startedAt = now();
      if (!Number.isSafeInteger(startedAt)) throw new Error("Dashboard candidate clock is invalid");
      const candidateId = nextCandidateId(store, createId);
      const summary = freezeSummary({ candidateId,
        createdAt: new Date(startedAt).toISOString(),
        expiresAt: new Date(startedAt + ttlMs).toISOString(),
        authority: candidate.authority,
        freezeManifestSha256: candidate.freezeManifestSha256,
        sourceSemanticHash: candidate.sourceSemanticHash,
        compileGraphHash: candidate.compileGraphHash,
        targetArtifactHash: candidate.targetArtifactHash,
        artifactSha256: candidate.artifactSha256,
      });
      store.save(freezeRecord({ summary, candidate }));
      return clone(summary);
    },
    read(value: unknown): DashboardNativeCandidateRecord {
      assertDashboardNativeCandidateLookup(value);
      const stored = store.load(value.candidateId);
      if (!stored) throw new DashboardNativeCandidateNotFoundError();
      if (Date.parse(stored.summary.expiresAt) <= now()) {
        store.remove(value.candidateId);
        throw new DashboardNativeCandidateExpiredError();
      }
      if (stored.summary.authority.projectId !== value.projectId
        || stored.summary.authority.applicationId !== value.applicationId) {
        throw new DashboardNativeCandidateAuthorityError();
      }
      return clone(stored);
    },
    remove(candidateId: string): void {
      if (!validId(candidateId)) throw new Error("Dashboard candidate id is invalid");
      store.remove(candidateId);
    },
  });
}

export function createInMemoryDashboardNativeCandidateRecordStore(now: () => number = Date.now): DashboardNativeCandidateRecordStore {
  const records = new Map<string, DashboardNativeCandidateRecord>();
  return Object.freeze({
    save(record: DashboardNativeCandidateRecord): void {
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp)) throw new Error("Dashboard candidate clock is invalid");
      // 新候选到达时回收无人再次读取的过期包；不淘汰仍可下载的有效记录。
      for (const [id, entry] of records) {
        if (Date.parse(entry.summary.expiresAt) <= timestamp) records.delete(id);
      }
      records.set(record.summary.candidateId, clone(record));
    },
    load(candidateId: string): DashboardNativeCandidateRecord | undefined {
      const record = records.get(candidateId);
      return record ? clone(record) : undefined;
    },
    remove(candidateId: string): void { records.delete(candidateId); },
  });
}

export class DashboardNativeCandidateNotFoundError extends Error {
  override readonly name = "DashboardNativeCandidateNotFoundError";
  constructor() { super("Dashboard Native candidate does not exist"); }
}

export class DashboardNativeCandidateExpiredError extends Error {
  override readonly name = "DashboardNativeCandidateExpiredError";
  constructor() { super("Dashboard Native candidate has expired"); }
}

export class DashboardNativeCandidateAuthorityError extends Error {
  override readonly name = "DashboardNativeCandidateAuthorityError";
  constructor() { super("Dashboard Native candidate does not belong to this project application"); }
}

export function assertDashboardNativeCandidateLookup(value: unknown): asserts value is DashboardNativeCandidateLookup {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("Dashboard candidate lookup must be a plain object");
  }
  const record = value as Record<string, unknown>;
  const fields = ["candidateId", "projectId", "applicationId"] as const;
  if (Object.keys(record).length !== fields.length || Object.keys(record).some(key => !fields.includes(key as typeof fields[number]))) {
    throw new Error("Dashboard candidate lookup contains unsupported client fields");
  }
  for (const field of fields) if (!validId(record[field])) throw new Error(`Dashboard candidate ${field} is invalid`);
}

function nextCandidateId(store: DashboardNativeCandidateRecordStore, createId: () => string): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidateId = createId();
    if (validId(candidateId) && !store.load(candidateId)) return candidateId;
  }
  throw new Error("Could not allocate a unique dashboard candidate id");
}

function freezeSummary(value: DashboardNativeCandidateSummary): DashboardNativeCandidateSummary { return Object.freeze(clone(value)); }
function freezeRecord(value: DashboardNativeCandidateRecord): DashboardNativeCandidateRecord { return Object.freeze(clone(value)); }
function clone<T>(value: T): T { return structuredClone(value); }
function validId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value); }
