import { describe, expect, it } from "vitest";
import { DashboardCandidateError, dashboardCandidateFilename, downloadFailureGuidance, initialDashboardOfflinePackageState,
  mapDashboardCandidateError, reduceDashboardOfflinePackage, summarizeCandidateObjects,
  type DashboardCandidatePrepared, type DashboardPublicationPointer } from "./dashboardOfflinePackageState";

const pointer: DashboardPublicationPointer = { id: "pub-1", projectId: "p", applicationId: "a",
  applicationRevision: 3, publishedAt: "2026-09-16T12:00:00.000Z" };
const candidate: DashboardCandidatePrepared = { candidateId: "cand-1", createdAt: "2026-09-16T12:00:01.000Z",
  expiresAt: "2026-09-16T13:00:01.000Z", applicationRevision: 3, entryPageId: "page-main",
  freezeManifestSha256: "a".repeat(64), targetArtifactHash: "b".repeat(64),
  objects: [{ nodeId: "n1", status: "supported", deferredFields: [] },
    { nodeId: "n2", status: "degraded", deferredFields: ["widget.filter"] },
    { nodeId: "n3", status: "blocked", deferredFields: ["scene"] }] };

describe("dashboard offline package state machine", () => {
  it("loads the publication pointer into idle or unpublished", () => {
    expect(reduceDashboardOfflinePackage(initialDashboardOfflinePackageState(), { type: "publication", pointer }))
      .toEqual({ phase: "idle", pointer });
    expect(reduceDashboardOfflinePackage(initialDashboardOfflinePackageState(), { type: "publication", pointer: undefined }))
      .toEqual({ phase: "unpublished" });
    // 发布事件只在装载阶段生效,准备途中的迟到回包不改变状态
    const preparing = reduceDashboardOfflinePackage({ phase: "idle", pointer }, { type: "prepare" });
    expect(reduceDashboardOfflinePackage(preparing, { type: "publication", pointer: undefined })).toBe(preparing);
  });

  it("moves prepare → prepared → ready and keeps the pointer through failure", () => {
    const preparing = reduceDashboardOfflinePackage({ phase: "idle", pointer }, { type: "prepare" });
    expect(preparing).toEqual({ phase: "preparing", pointer });
    const ready = reduceDashboardOfflinePackage(preparing, { type: "prepared", candidate });
    expect(ready.phase).toBe("ready");
    const failed = reduceDashboardOfflinePackage(ready, { type: "failed",
      error: new DashboardCandidateError("candidate_stale", "失效", 409) });
    expect(failed).toEqual({ phase: "failed", pointer, error: expect.any(DashboardCandidateError) });
    // 失败后可重新准备;取消只在准备途中有效
    expect(reduceDashboardOfflinePackage(failed, { type: "prepare" }).phase).toBe("preparing");
    expect(reduceDashboardOfflinePackage(preparing, { type: "cancelled" })).toEqual({ phase: "idle", pointer });
  });

  it("drops stale prepared events and refuses prepare from transient phases", () => {
    const preparing = reduceDashboardOfflinePackage({ phase: "idle", pointer }, { type: "prepare" });
    const settled = reduceDashboardOfflinePackage(preparing, { type: "cancelled" });
    expect(reduceDashboardOfflinePackage(settled, { type: "prepared", candidate })).toBe(settled);
    expect(reduceDashboardOfflinePackage(initialDashboardOfflinePackageState(), { type: "prepare" }).phase).toBe("loading");
    expect(reduceDashboardOfflinePackage({ phase: "unpublished" }, { type: "prepare" }).phase).toBe("unpublished");
    expect(reduceDashboardOfflinePackage(preparing, { type: "prepare" })).toBe(preparing);
  });
});

describe("dashboard candidate failure mapping", () => {
  it("maps server 409/410 codes to typed failures and keeps the server message", () => {
    const stale = mapDashboardCandidateError(Object.assign(new Error("版本已变更"), { status: 409, body: { code: "candidate_stale" } }));
    expect(stale).toBeInstanceOf(DashboardCandidateError);
    expect(stale.code).toBe("candidate_stale");
    expect(stale.message).toBe("版本已变更");
    expect(mapDashboardCandidateError(Object.assign(new Error("已过期"), { status: 410, body: { code: "candidate_expired" } })).code)
      .toBe("candidate_expired");
  });

  it("routes auth/network/unknown failures to candidate_rejected without inventing codes", () => {
    expect(mapDashboardCandidateError({ status: 401, body: { message: "请先登录" } }).code).toBe("candidate_rejected");
    expect(mapDashboardCandidateError(new TypeError("fetch failed")).status).toBe(0);
    const passthrough = new DashboardCandidateError("candidate_timeout", "超时", 409);
    expect(mapDashboardCandidateError(passthrough)).toBe(passthrough);
  });

  it("gives actionable guidance for expired or invalid downloads", () => {
    expect(downloadFailureGuidance(new DashboardCandidateError("candidate_expired", "x", 410))).toContain("重新准备");
    expect(downloadFailureGuidance(new DashboardCandidateError("candidate_invalid", "x", 409))).toContain("重新准备");
    expect(downloadFailureGuidance(new DashboardCandidateError("candidate_rejected", "服务返回空响应（HTTP 503）", 503)))
      .toBe("服务返回空响应（HTTP 503）");
  });
});

describe("dashboard candidate download helpers", () => {
  it("parses the attachment filename and falls back to the candidate id", () => {
    expect(dashboardCandidateFilename("attachment; filename=\"dashboard-candidate-abc.exe\"", "abc", "exe"))
      .toBe("dashboard-candidate-abc.exe");
    expect(dashboardCandidateFilename(null, "cand-1", "zip")).toBe("dashboard-candidate-cand-1.zip");
    expect(dashboardCandidateFilename("attachment; filename=\"..\\\\evil.exe\"", "abc", "exe")).toBe("dashboard-candidate-abc.exe");
  });

  it("summarizes object statuses for the capability display", () => {
    expect(summarizeCandidateObjects(candidate.objects)).toEqual({ supported: 1, degraded: 1, blocked: 1, total: 3 });
  });
});
