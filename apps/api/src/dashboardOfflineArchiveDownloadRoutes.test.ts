import { describe, expect, it, vi } from "vitest";
import { createApiServer } from "./serverOptions.js";
import { registerDashboardOfflineArchiveDownloadRoutes } from "./dashboardOfflineArchiveDownloadRoutes.js";
import {
  DashboardNativeCandidateAuthorityError,
  DashboardNativeCandidateExpiredError,
  DashboardNativeCandidateNotFoundError,
  type DashboardNativeCandidateRecord,
} from "./dashboardNativeCandidateRegistry.js";

const authority = { projectId: "project-1", applicationId: "application-1", publicationId: "publication-1", applicationRevision: 3, entryPageId: "page-main" } as const;
const path = `/api/projects/${authority.projectId}/applications/${authority.applicationId}/dashboard-candidates/candidate-1/offline-archive`;

function record(): DashboardNativeCandidateRecord {
  return {
    summary: { candidateId: "candidate-1", createdAt: "2026-09-16T12:00:00.000Z", expiresAt: "2026-09-16T12:15:00.000Z", authority,
      freezeManifestSha256: "a".repeat(64), sourceSemanticHash: "b".repeat(64), compileGraphHash: "c".repeat(64), targetArtifactHash: "d".repeat(64), artifactSha256: "d".repeat(64) },
    candidate: { authority, freezeManifestSha256: "a".repeat(64), sourceSemanticHash: "b".repeat(64), compileGraphHash: "c".repeat(64), targetArtifactHash: "d".repeat(64), artifactSha256: "d".repeat(64),
      capability: {} as never, artifact: { artifact: Uint8Array.of(1, 2, 3) } as never } as never,
  };
}

async function fixture(options: {
  readonly user?: { readonly id: string; readonly role: string; readonly projectIds: readonly string[]; readonly enabled: boolean };
  readonly read?: () => DashboardNativeCandidateRecord;
  readonly readFreezeManifest?: () => Promise<unknown>;
  readonly createArchive?: ReturnType<typeof vi.fn>;
  readonly serializeArchive?: ReturnType<typeof vi.fn>;
} = {}) {
  const app = createApiServer();
  if (options.user) app.addHook("preHandler", async request => { request.systemUser = options.user as never; });
  const registry = { read: vi.fn(options.read ?? record) };
  const readFreezeManifest = vi.fn(options.readFreezeManifest ?? (async () => ({ manifest: "server-only" })));
  const createArchive = options.createArchive ?? vi.fn(() => ({ archive: "private" }));
  const serializeArchive = options.serializeArchive ?? vi.fn(() => Uint8Array.of(0x44, 0x4d, 0x44, 0x41));
  await registerDashboardOfflineArchiveDownloadRoutes(app, { registry, readFreezeManifest: readFreezeManifest as never,
    createArchive: createArchive as never, serializeArchive: serializeArchive as never });
  return { app, registry, readFreezeManifest, createArchive, serializeArchive };
}

const editor = { id: "editor-1", role: "editor", projectIds: [authority.projectId], enabled: true } as const;

describe("dashboard offline archive download routes", () => {
  it("requires identity and project authority before touching a private candidate", async () => {
    for (const user of [undefined, { ...editor, role: "viewer" }, { ...editor, projectIds: ["other-project"] }]) {
      const f = await fixture({ user });
      const response = await f.app.inject({ method: "GET", url: path });
      expect(response.statusCode).toBe(user ? 403 : 401);
      expect(f.registry.read).not.toHaveBeenCalled();
      await f.app.close();
    }
  });

  it("scopes the server-only candidate lookup to candidate, project, and application", async () => {
    const f = await fixture({ user: editor });
    const response = await f.app.inject({ method: "GET", url: path });
    expect(response.statusCode).toBe(200);
    expect(f.registry.read).toHaveBeenCalledWith({ candidateId: "candidate-1", projectId: authority.projectId, applicationId: authority.applicationId });
    expect(f.readFreezeManifest).toHaveBeenCalledWith({ record: expect.objectContaining({
      summary: expect.objectContaining({ candidateId: "candidate-1" }),
    }), signal: expect.any(AbortSignal) });
    expect(f.createArchive).toHaveBeenCalledWith({ freezeManifest: { manifest: "server-only" }, capability: record().candidate.capability, artifact: Uint8Array.of(1, 2, 3) });
    await f.app.close();
  });

  it("returns only a no-store attachment stream, never JSON with the archive or artifact", async () => {
    const f = await fixture({ user: editor });
    const response = await f.app.inject({ method: "GET", url: path });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/octet-stream");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="dashboard-candidate-candidate-1.dmda"');
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.rawPayload).toEqual(Buffer.from([0x44, 0x4d, 0x44, 0x41]));
    expect(response.body).not.toContain("private");
    expect(response.body).not.toContain("artifact");
    await f.app.close();
  });

  it.each([
    [new DashboardNativeCandidateNotFoundError(), 404, undefined],
    [new DashboardNativeCandidateAuthorityError(), 404, undefined],
    [new DashboardNativeCandidateExpiredError(), 410, "candidate_expired"],
    [new Error("bad id"), 400, undefined],
  ])("maps lookup failures without reading or serializing an artifact", async (error, status, code) => {
    const f = await fixture({ user: editor, read: () => { throw error; } });
    const response = await f.app.inject({ method: "GET", url: path });
    expect(response.statusCode).toBe(status);
    if (code) expect(response.json()).toMatchObject({ code });
    expect(f.readFreezeManifest).not.toHaveBeenCalled();
    expect(f.serializeArchive).not.toHaveBeenCalled();
    await f.app.close();
  });

  it("fails closed if the frozen manifest cannot be resolved or archive generation rejects it", async () => {
    const missing = await fixture({ user: editor, readFreezeManifest: async () => undefined });
    expect((await missing.app.inject({ method: "GET", url: path })).statusCode).toBe(409);
    expect(missing.serializeArchive).not.toHaveBeenCalled();
    await missing.app.close();

    const invalid = await fixture({ user: editor, createArchive: vi.fn(() => { throw new Error("private validation detail"); }) });
    const response = await invalid.app.inject({ method: "GET", url: path });
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain("private validation detail");
    expect(invalid.serializeArchive).not.toHaveBeenCalled();
    await invalid.app.close();
  });
});
