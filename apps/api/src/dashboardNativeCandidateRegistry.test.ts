import { describe, expect, it } from "vitest";
import type { DashboardNativeCandidate } from "./dashboardNativeCandidateService.js";
import {
  createDashboardNativeCandidateRegistry,
  createInMemoryDashboardNativeCandidateRecordStore,
  DashboardNativeCandidateAuthorityError,
  DashboardNativeCandidateExpiredError,
  DashboardNativeCandidateNotFoundError,
} from "./dashboardNativeCandidateRegistry.js";

const authority = { projectId: "project-golden", applicationId: "application-dashboard", publicationId: "publication-1",
  applicationRevision: 7, entryPageId: "page-main" } as const;

function candidate(): DashboardNativeCandidate {
  return {
    authority, freezeManifestSha256: "a".repeat(64), sourceSemanticHash: "b".repeat(64),
    compileGraphHash: "c".repeat(64), targetArtifactHash: "d".repeat(64), artifactSha256: "d".repeat(64),
    windowVerification: { verifier: "native-dashboard-window-v1", authority, freezeManifestSha256: "a".repeat(64),
      sourceSemanticHash: "b".repeat(64), compileGraphHash: "c".repeat(64), targetArtifactHash: "d".repeat(64),
      fixtureSha256: "e".repeat(64), deviceFingerprintSha256: "f".repeat(64), fontSha256: [], renderedNodeIds: [] },
    capability: { schema: "deep-engine.dashboard-publication-capability", schemaVersion: 1, authority,
      freezeManifestSha256: "a".repeat(64), sourceSemanticHash: "b".repeat(64), compileGraphHash: "c".repeat(64),
      targetArtifactHash: "d".repeat(64), compiler: { id: "native", version: "1", sha256: "1".repeat(64), configurationSha256: "2".repeat(64) },
      evidence: { verifier: "native-dashboard-window-v1", fixtureSha256: "e".repeat(64), deviceFingerprintSha256: "f".repeat(64), fontSha256: [] }, objects: [] },
    artifact: { artifact: new Uint8Array([1, 2, 3]), artifactSha256: "d".repeat(64), runtimePackage: {} as never,
      authority, freezeManifestSha256: "a".repeat(64), sourceSemanticHash: "b".repeat(64), compileGraphHash: "c".repeat(64) },
  };
}

describe("dashboard Native candidate registry", () => {
  it("reclaims unread expired records on registration without evicting live packages", () => {
    let time = 100;
    let id = 0;
    const store = createInMemoryDashboardNativeCandidateRecordStore(() => time);
    const registry = createDashboardNativeCandidateRegistry({ store, now: () => time, ttlMs: 10,
      createId: () => `candidate-${++id}` });
    const expired = registry.register(candidate());
    time = 105;
    const active = registry.register(candidate());
    time = 109;
    registry.register(candidate());
    expect(store.load(expired.candidateId)).toBeDefined();
    time = 110;
    registry.register(candidate());
    expect(store.load(expired.candidateId)).toBeUndefined();
    const lookup = { candidateId: active.candidateId, projectId: authority.projectId, applicationId: authority.applicationId };
    const record = registry.read(lookup);
    record.candidate.artifact.artifact[0] = 99;
    expect(registry.read(lookup).candidate.artifact.artifact).toEqual(new Uint8Array([1, 2, 3]));
    expect(() => registry.read({ ...lookup, projectId: "other-project" })).toThrow(DashboardNativeCandidateAuthorityError);
  });

  it("rejects an invalid store clock before deleting or inserting records", () => {
    let time = 100;
    const store = createInMemoryDashboardNativeCandidateRecordStore(() => time);
    const registry = createDashboardNativeCandidateRegistry({ store, now: () => 100, ttlMs: 10, createId: () => "existing" });
    registry.register(candidate());
    const record = store.load("existing")!;
    for (const invalid of [NaN, Infinity, 1.5]) {
      time = invalid;
      expect(() => store.save({ ...record, summary: { ...record.summary, candidateId: "new" } })).toThrow("clock is invalid");
      expect(store.load("existing")).toEqual(record);
      expect(store.load("new")).toBeUndefined();
    }
  });

  it("returns only safe metadata at registration and retains private bytes for a scoped server read", () => {
    const registry = createDashboardNativeCandidateRegistry({ now: () => Date.parse("2026-09-16T12:00:00.000Z"), createId: () => "candidate-1" });
    const summary = registry.register(candidate());
    expect(summary).toEqual({ candidateId: "candidate-1", createdAt: "2026-09-16T12:00:00.000Z", expiresAt: "2026-09-16T12:15:00.000Z",
      authority, freezeManifestSha256: "a".repeat(64), sourceSemanticHash: "b".repeat(64), compileGraphHash: "c".repeat(64),
      targetArtifactHash: "d".repeat(64), artifactSha256: "d".repeat(64) });
    expect(summary).not.toHaveProperty("artifact");
    const record = registry.read({ candidateId: summary.candidateId, projectId: authority.projectId, applicationId: authority.applicationId });
    expect(record.candidate.artifact.artifact).toEqual(new Uint8Array([1, 2, 3]));
    record.candidate.artifact.artifact[0] = 99;
    expect(registry.read({ candidateId: summary.candidateId, projectId: authority.projectId, applicationId: authority.applicationId }).candidate.artifact.artifact[0]).toBe(1);
  });

  it("rejects expiry and removes the expired record", () => {
    let time = 100;
    const registry = createDashboardNativeCandidateRegistry({ ttlMs: 10, now: () => time, createId: () => "candidate-expired" });
    registry.register(candidate()); time = 110;
    const lookup = { candidateId: "candidate-expired", projectId: authority.projectId, applicationId: authority.applicationId };
    expect(() => registry.read(lookup)).toThrow(DashboardNativeCandidateExpiredError);
    expect(() => registry.read(lookup)).toThrow(DashboardNativeCandidateNotFoundError);
  });

  it("binds reads to project and application without consuming a valid record", () => {
    const registry = createDashboardNativeCandidateRegistry({ createId: () => "candidate-bound" });
    registry.register(candidate());
    expect(() => registry.read({ candidateId: "candidate-bound", projectId: "other-project", applicationId: authority.applicationId }))
      .toThrow(DashboardNativeCandidateAuthorityError);
    expect(registry.read({ candidateId: "candidate-bound", projectId: authority.projectId, applicationId: authority.applicationId }).summary.candidateId)
      .toBe("candidate-bound");
  });

  it("rejects browser-shaped content, hashes, and malformed scope fields", () => {
    const registry = createDashboardNativeCandidateRegistry();
    expect(() => registry.read({ candidateId: "candidate-1", projectId: authority.projectId, applicationId: authority.applicationId,
      artifact: "browser-bytes" })).toThrow("unsupported client fields");
    expect(() => registry.read({ candidateId: "bad/id", projectId: authority.projectId, applicationId: authority.applicationId }))
      .toThrow("candidateId is invalid");
  });
});
