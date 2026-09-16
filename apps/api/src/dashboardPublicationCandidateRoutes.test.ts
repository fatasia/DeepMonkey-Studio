import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiServer } from "./serverOptions.js";
import { registerDashboardPublicationCandidateRoutes } from "./dashboardPublicationCandidateRoutes.js";
import type { DashboardNativeCandidateService } from "./dashboardNativeCandidateService.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

const authority = {
  projectId: "project-1",
  applicationId: "application-1",
  publicationId: "publication-1",
  applicationRevision: 3,
  entryPageId: "page-main",
} as const;

function candidate(): Awaited<ReturnType<DashboardNativeCandidateService["prepare"]>> {
  return {
    authority,
    freezeManifestSha256: "a".repeat(64),
    sourceSemanticHash: "b".repeat(64),
    compileGraphHash: "c".repeat(64),
    targetArtifactHash: "d".repeat(64),
    artifactSha256: "d".repeat(64),
    windowVerification: { verifier: "native-dashboard-window-v1" },
    capability: { objects: [{ nodeId: "widget-1", status: "supported", deferredFields: [] }] },
    artifact: { bytes: new Uint8Array([1, 2, 3]) },
  } as unknown as Awaited<ReturnType<DashboardNativeCandidateService["prepare"]>>;
}

async function fixture(options: {
  readonly service?: Pick<DashboardNativeCandidateService, "prepare">;
  readonly user?: { readonly id: string; readonly role: string; readonly projectIds: readonly string[]; readonly enabled: boolean };
} = {}) {
  const app = createApiServer();
  cleanups.push(() => app.close());
  if (options.user) app.addHook("preHandler", async request => { request.systemUser = options.user as never; });
  await registerDashboardPublicationCandidateRoutes(app, options.service);
  return app;
}

const request = (app: Awaited<ReturnType<typeof fixture>>, payload: unknown) => app.inject({
  method: "POST",
  url: `/api/projects/${authority.projectId}/applications/${authority.applicationId}/dashboard-candidates`,
  payload,
});

describe("dashboard publication candidate routes", () => {
  it("requires an authenticated user before parsing or preparing a candidate", async () => {
    const prepare = vi.fn();
    const app = await fixture({ service: { prepare } as never });
    expect((await request(app, authority)).statusCode).toBe(401);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects viewer and foreign-project users without calling the candidate service", async () => {
    const prepare = vi.fn();
    for (const user of [
      { id: "viewer", role: "viewer", projectIds: [authority.projectId], enabled: true },
      { id: "foreign", role: "editor", projectIds: ["project-other"], enabled: true },
    ]) {
      const app = await fixture({ service: { prepare } as never, user });
      expect((await request(app, authority)).statusCode).toBe(403);
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each([
    { ...authority, document: {} },
    { ...authority, data: [] },
    { ...authority, resources: [] },
    { ...authority, targetArtifactHash: "a".repeat(64) },
    { publicationId: authority.publicationId, applicationRevision: 3 },
    { publicationId: authority.publicationId, applicationRevision: 0, entryPageId: authority.entryPageId },
  ])("rejects non-authority client input before preparation", async payload => {
    const prepare = vi.fn();
    const app = await fixture({ service: { prepare } as never, user: { id: "editor", role: "editor", projectIds: [authority.projectId], enabled: true } });
    expect((await request(app, payload)).statusCode).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("reports an unconfigured service without accepting browser-controlled artifacts", async () => {
    const app = await fixture({ user: { id: "editor", role: "editor", projectIds: [authority.projectId], enabled: true } });
    expect((await request(app, {
      publicationId: authority.publicationId,
      applicationRevision: authority.applicationRevision,
      entryPageId: authority.entryPageId,
    })).statusCode).toBe(503);
  });

  it("passes server-derived authority to the service and exposes metadata only", async () => {
    const prepare = vi.fn().mockResolvedValue(candidate());
    const app = await fixture({ service: { prepare } as never, user: { id: "editor", role: "editor", projectIds: [authority.projectId], enabled: true } });
    const response = await request(app, {
      publicationId: authority.publicationId,
      applicationRevision: authority.applicationRevision,
      entryPageId: authority.entryPageId,
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(prepare).toHaveBeenCalledWith(authority, expect.any(AbortSignal));
    expect(response.json()).toMatchObject({ candidateId: expect.any(String), authority, artifactSha256: "d".repeat(64),
      verifier: "native-dashboard-window-v1", objects: [{ nodeId: "widget-1", status: "supported" }] });
    const metadata = response.json() as Record<string, unknown>;
    expect(metadata).not.toHaveProperty("artifact");
    expect(metadata).not.toHaveProperty("capability");
    expect(metadata).not.toHaveProperty("windowVerification");
  });

  it.each([
    ["DashboardPublicationStaleError", "candidate_stale"],
    ["DashboardNativeCandidateSupersededError", "candidate_concurrent"],
    ["TimeoutError", "candidate_timeout"],
    ["CompilerFailure", "candidate_invalid"],
  ] as const)("maps %s to a retryable conflict without returning compiler details", async (name, code) => {
    const reason = name === "TimeoutError" ? new DOMException("expired", name) : Object.assign(new Error("private compiler detail"), { name });
    const prepare = vi.fn().mockRejectedValue(reason);
    const app = await fixture({ service: { prepare } as never, user: { id: "editor", role: "editor", projectIds: [authority.projectId], enabled: true } });
    const response = await request(app, {
      publicationId: authority.publicationId,
      applicationRevision: authority.applicationRevision,
      entryPageId: authority.entryPageId,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code, message: "Dashboard 候选版本在校验窗口内失效，请刷新后重试" });
  });
});
