import { describe, expect, it, vi } from "vitest";
import { createApiServer } from "./serverOptions.js";
import { registerDashboardOfflineArchiveDownloadRoutes } from "./dashboardOfflineArchiveDownloadRoutes.js";
import type { DashboardOfflineArchiveDownloadDependencies } from "./dashboardOfflineArchiveDownloadRoutes.js";
import nodePath from "node:path";
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
  readonly portable?: DashboardOfflineArchiveDownloadDependencies["portable"];
} = {}) {
  const app = createApiServer();
  if (options.user) app.addHook("preHandler", async request => { request.systemUser = options.user as never; });
  const registry = { read: vi.fn(options.read ?? record) };
  const readFreezeManifest = vi.fn(options.readFreezeManifest ?? (async () => ({ manifest: "server-only" })));
  const createArchive = options.createArchive ?? vi.fn(() => ({ archive: "private" }));
  const serializeArchive = options.serializeArchive ?? vi.fn(() => Uint8Array.of(0x44, 0x4d, 0x44, 0x41));
  await registerDashboardOfflineArchiveDownloadRoutes(app, { registry, readFreezeManifest: readFreezeManifest as never,
    createArchive: createArchive as never, serializeArchive: serializeArchive as never, portable: options.portable });
  return { app, registry, readFreezeManifest, createArchive, serializeArchive };
}

const editor = { id: "editor-1", role: "editor", projectIds: [authority.projectId], enabled: true } as const;

describe("dashboard offline archive download routes", () => {
  const zipPath = path.replace("offline-archive", "portable-zip");
  const executable = nodePath.resolve("server-only-player.exe");
  const exePath = path.replace("offline-archive", "standalone-executable");

  it("finishes a real HTTP download after asynchronous packaging", async () => {
    const f = await fixture({ user: editor, portable: { nativeExecutable: executable,
      createExecutable: async (_archive, _file, options) => {
        await new Promise(resolve => setTimeout(resolve, 25));
        options?.signal?.throwIfAborted();
        return Uint8Array.of(0x4d, 0x5a);
      } } });
    try {
      const origin = await f.app.listen({ host: "127.0.0.1", port: 0 });
      const response = await fetch(origin + exePath);
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.of(0x4d, 0x5a));
    } finally { await f.app.close(); }
  });

  it("cancels packaging when the HTTP client disconnects while awaiting bytes", async () => {
    let signal: AbortSignal | undefined;
    let ready!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture({ user: editor, portable: { nativeExecutable: executable,
      createExecutable: async (_archive, _file, options) => {
        signal = options?.signal; ready(); await blocked;
        signal?.throwIfAborted(); return Uint8Array.of(0x4d, 0x5a);
      } } });
    try {
      const origin = await f.app.listen({ host: "127.0.0.1", port: 0 });
      const controller = new AbortController();
      const download = fetch(origin + exePath, { signal: controller.signal }).catch(error => error);
      await started; controller.abort(); await download;
      await vi.waitFor(() => expect(signal?.aborted).toBe(true), { timeout: 1000 });
    } finally { release(); await f.app.close(); }
  });

  it("serves a single EXE using the deployment executable and verified DMDA bytes", async () => {
    const unavailable = await fixture({ user: editor });
    expect((await unavailable.app.inject({ method: "GET", url: exePath })).statusCode).toBe(404);
    await unavailable.app.close();
    const createExecutable = vi.fn(async () => Uint8Array.of(0x4d, 0x5a, 1));
    const f = await fixture({ user: editor, portable: { nativeExecutable: executable, createExecutable } });
    try {
      const response = await f.app.inject({ method: "GET", url: exePath });
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(Buffer.from([0x4d, 0x5a, 1]));
      expect(response.headers["content-type"]).toBe("application/vnd.microsoft.portable-executable");
      expect(response.headers["content-disposition"]).toBe('attachment; filename="dashboard-candidate-candidate-1.exe"');
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers["content-length"]).toBe("3");
      expect(createExecutable).toHaveBeenCalledWith(Uint8Array.of(0x44, 0x4d, 0x44, 0x41), executable, { signal: expect.any(AbortSignal) });
      expect(f.registry.read).toHaveBeenCalledTimes(2);
      expect((await f.app.inject({ method: "GET", url: exePath + "?nativeExecutable=evil.exe" })).statusCode).toBe(400);
      expect(createExecutable).toHaveBeenCalledTimes(1);
    } finally { await f.app.close(); }
  });

  it.each([undefined, { ...editor, role: "viewer" }, { ...editor, projectIds: ["other"] }])("authorizes EXE before accessing its candidate", async user => {
    const createExecutable = vi.fn(async () => new Uint8Array());
    const f = await fixture({ user, portable: { nativeExecutable: executable, createExecutable } });
    try {
      expect((await f.app.inject({ method: "GET", url: exePath })).statusCode).toBe(user ? 403 : 401);
      expect(f.registry.read).not.toHaveBeenCalled(); expect(createExecutable).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });

  it.each([[new DashboardNativeCandidateExpiredError(), 410], [new DashboardNativeCandidateNotFoundError(), 404], [new DashboardNativeCandidateAuthorityError(), 404]])("rechecks candidate validity after asynchronous EXE generation", async (error, status) => {
    let invalid = false;
    const f = await fixture({ user: editor, read: () => { if (invalid) throw error; return record(); },
      portable: { nativeExecutable: executable, createExecutable: async () => { await Promise.resolve(); invalid = true; return Uint8Array.of(0x4d, 0x5a); } } });
    try {
      const response = await f.app.inject({ method: "GET", url: exePath });
      expect(response.statusCode).toBe(status); expect(response.headers["content-disposition"]).toBeUndefined();
      expect(f.registry.read).toHaveBeenLastCalledWith({ candidateId: "candidate-1", projectId: authority.projectId, applicationId: authority.applicationId });
    } finally { await f.app.close(); }
  });

  it("does not return partial EXE bytes when packaging fails", async () => {
    const f = await fixture({ user: editor, portable: { nativeExecutable: executable,
      createExecutable: async () => { throw new Error("private executable detail"); } } });
    try {
      const response = await f.app.inject({ method: "GET", url: exePath });
      expect(response.statusCode).toBe(409); expect(response.headers["content-disposition"]).toBeUndefined();
      expect(response.body).not.toContain("private executable detail");
    } finally { await f.app.close(); }
  });

  it.each(["", "relative.exe", nodePath.resolve("player.dll")])("rejects invalid deployment executable configuration: %s", async nativeExecutable => {
    const app = createApiServer();
    try {
      await expect(registerDashboardOfflineArchiveDownloadRoutes(app, {
        registry: { read: record }, readFreezeManifest: async () => undefined, portable: { nativeExecutable },
      })).rejects.toThrow("absolute .exe");
    } finally { await app.close(); }
  });

  it("registers ZIP only with a fixed deployment executable and preserves DMDA", async () => {
    const unavailable = await fixture({ user: editor });
    expect((await unavailable.app.inject({ method: "GET", url: zipPath })).statusCode).toBe(404);
    await unavailable.app.close();
    const createZip = vi.fn(async () => Uint8Array.of(0x50, 0x4b, 1));
    const f = await fixture({ user: editor, portable: { nativeExecutable: executable, createZip } });
    try {
      const response = await f.app.inject({ method: "GET", url: zipPath });
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(Buffer.from([0x50, 0x4b, 1]));
      expect(response.headers["content-type"]).toBe("application/zip");
      expect(response.headers["content-disposition"]).toBe('attachment; filename="dashboard-candidate-candidate-1.zip"');
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers["content-length"]).toBe("3");
      expect(createZip).toHaveBeenCalledWith(Uint8Array.of(0x44, 0x4d, 0x44, 0x41), executable, { signal: expect.any(AbortSignal) });
      expect(f.registry.read).toHaveBeenCalledTimes(2);
      expect((await f.app.inject({ method: "GET", url: path })).statusCode).toBe(200);
      expect(createZip).toHaveBeenCalledTimes(1);
    } finally { await f.app.close(); }
  });

  it.each([undefined, { ...editor, role: "viewer" }, { ...editor, projectIds: ["other"] }])("authorizes ZIP before touching private candidates", async user => {
    const createZip = vi.fn(async () => new Uint8Array());
    const f = await fixture({ user, portable: { nativeExecutable: executable, createZip } });
    try {
      const response = await f.app.inject({ method: "GET", url: zipPath });
      expect(response.statusCode).toBe(user ? 403 : 401);
      expect(f.registry.read).not.toHaveBeenCalled(); expect(createZip).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });

  it("rejects client executable overrides and all ZIP query arguments", async () => {
    const createZip = vi.fn(async () => new Uint8Array());
    const f = await fixture({ user: editor, portable: { nativeExecutable: executable, createZip } });
    try {
      for (const query of ["?nativeExecutable=evil.exe", "?format=dmda", "?x=1"]) {
        expect((await f.app.inject({ method: "GET", url: zipPath + query })).statusCode).toBe(400);
      }
      expect(f.registry.read).not.toHaveBeenCalled(); expect(createZip).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });

  it.each([[new DashboardNativeCandidateExpiredError(), 410], [new DashboardNativeCandidateNotFoundError(), 404], [new DashboardNativeCandidateAuthorityError(), 404]])("rechecks scope and lifetime after asynchronous ZIP preparation", async (error, status) => {
    let expired = false;
    const createZip = vi.fn(async () => { await Promise.resolve(); expired = true; return Uint8Array.of(0x50, 0x4b); });
    const f = await fixture({ user: editor, portable: { nativeExecutable: executable, createZip }, read: () => { if (expired) throw error; return record(); } });
    try {
      const response = await f.app.inject({ method: "GET", url: zipPath });
      expect(response.statusCode).toBe(status); expect(response.headers["content-disposition"]).toBeUndefined();
      expect(f.registry.read).toHaveBeenLastCalledWith({ candidateId: "candidate-1", projectId: authority.projectId, applicationId: authority.applicationId });
    } finally { await f.app.close(); }
  });

  it("does not expose ZIP generation failures or attach partial bytes", async () => {
    const f = await fixture({ user: editor, portable: { nativeExecutable: executable, createZip: async () => { throw new Error("private executable path"); } } });
    try {
      const response = await f.app.inject({ method: "GET", url: zipPath });
      expect(response.statusCode).toBe(409); expect(response.headers["content-disposition"]).toBeUndefined();
      expect(response.body).not.toContain("private executable path");
    } finally { await f.app.close(); }
  });

  it.each([
    [new DashboardNativeCandidateExpiredError(), 410],
    [new DashboardNativeCandidateNotFoundError(), 404],
  ])("rechecks candidate lifetime before sending a prepared download", async (error, status) => {
    let revoked = false;
    const f = await fixture({ user: editor,
      read: () => { if (revoked) throw error; return record(); },
      readFreezeManifest: async () => { revoked = true; return { manifest: "server-only" }; },
    });
    try {
      const response = await f.app.inject({ method: "GET", url: path });
      expect(response.statusCode).toBe(status);
      expect(response.headers["content-disposition"]).toBeUndefined();
      expect(f.registry.read).toHaveBeenCalledTimes(2);
    } finally { await f.app.close(); }
  });

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
