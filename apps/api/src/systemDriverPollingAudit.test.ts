import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { JsonStore } from "./jsonStore.js";
import { registerSystemRoutes } from "./system.js";

it("keeps empty driver polls out of metadata while retaining work, errors and mutation audit", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "studio-poll-audit-"));
  const app = Fastify(), store = new JsonStore(directory);
  try {
    await store.init();
    await registerSystemRoutes(app, store, directory);
    for (const route of ["next", "snapshot-request", "result", "snapshot-result", "next-extra"]) {
      app.post(`/api/editor-scene-driver/:sessionId/${route}`, async (request, reply) => {
        const status = (request.body as { status?: number })?.status ?? 204;
        return reply.code(status).send(status === 204 ? undefined : { status });
      });
    }
    app.put("/api/editor-presence/:sessionId", async (request, reply) =>
      reply.code((request.body as { status?: number })?.status ?? 200).send({ heartbeat: true }));
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: process.env.BIM_STUDIO_ADMIN_PASSWORD ?? "admin" } });
    const headers = { authorization: `Bearer ${login.json().token}` };
    const audit = vi.spyOn(store, "addAuditLog");
    for (let index = 0; index < 12; index++) for (const route of ["next", "snapshot-request"]) {
      expect((await app.inject({ method: "POST", url: `/api/editor-scene-driver/session/${route}`, headers })).statusCode).toBe(204);
    }
    await app.inject({ method: "PUT", url: "/api/editor-presence/session", headers });
    expect(audit).not.toHaveBeenCalled();
    for (const [route, status] of [["next", 200], ["snapshot-request", 400], ["result", 204], ["snapshot-result", 204], ["next-extra", 204]] as const) {
      await app.inject({ method: "POST", url: `/api/editor-scene-driver/session/${route}`, headers, payload: { status } });
    }
    await app.inject({ method: "PUT", url: "/api/editor-presence/session", headers, payload: { status: 400 } });
    await app.close();
    expect(audit).toHaveBeenCalledTimes(6);
    expect(store.listAuditLogs()).toContainEqual(expect.objectContaining({ action: "error", statusCode: 400 }));
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
