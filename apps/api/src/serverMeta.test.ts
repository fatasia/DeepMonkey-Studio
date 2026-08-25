import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { StoredSystemUserRecord } from "@bim-studio/contracts";
import { createServerMeta, loadOrCreateServerInstanceId, registerServerMetaRoute } from "./serverMeta.js";
import { registerSystemRoutes } from "./system.js";
import type { MetadataStore } from "./store.js";

const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

describe("server metadata", () => {
  it("keeps one serverInstanceId for one data directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-meta-"));
    directories.push(directory);
    expect(await loadOrCreateServerInstanceId(directory)).toBe(await loadOrCreateServerInstanceId(directory));
  });

  it("converges on one serverInstanceId during concurrent initialization", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-meta-race-"));
    directories.push(directory);
    const instanceIds = await Promise.all(Array.from({ length: 16 }, () => loadOrCreateServerInstanceId(directory)));
    expect([...new Set(instanceIds)]).toHaveLength(1);
  });

  it("uses different serverInstanceIds for different data directories", async () => {
    const first = await mkdtemp(path.join(tmpdir(), "bim-meta-first-"));
    const second = await mkdtemp(path.join(tmpdir(), "bim-meta-second-"));
    directories.push(first, second);
    expect(await loadOrCreateServerInstanceId(first)).not.toBe(await loadOrCreateServerInstanceId(second));
  });

  it("rejects malformed persisted serverInstanceId content", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-meta-invalid-"));
    directories.push(directory);
    await writeFile(path.join(directory, "server-instance-id"), "not-an-id\n", "utf8");

    await expect(loadOrCreateServerInstanceId(directory)).rejects.toThrow("server-instance-id 文件无效");
  });

  it("accepts and normalizes uppercase persisted UUID text", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-meta-uppercase-"));
    directories.push(directory);
    await writeFile(path.join(directory, "server-instance-id"), "3D3AE7AB-2A96-43C3-8354-2BA4D56CF8AA\n", "utf8");

    await expect(loadOrCreateServerInstanceId(directory)).resolves.toBe("3d3ae7ab-2a96-43c3-8354-2ba4d56cf8aa");
  });

  it("rejects an empty persisted serverInstanceId file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-meta-empty-"));
    directories.push(directory);
    await writeFile(path.join(directory, "server-instance-id"), "\n", "utf8");

    await expect(loadOrCreateServerInstanceId(directory)).rejects.toThrow("server-instance-id 文件为空");
  });

  it("returns the public capability contract", async () => {
    const app = Fastify();
    await registerServerMetaRoute(app, "server-test", () => new Date("2026-08-25T00:00:00.000Z"));
    const response = await app.inject({ method: "GET", url: "/api/meta" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(createServerMeta("server-test", () => new Date("2026-08-25T00:00:00.000Z")));
    expect(response.json().capabilities.applications).toEqual({ schemaVersions: [2], immutablePublications: true });
    await app.close();
  });

  it("exempts only the exact metadata route from system authentication", async () => {
    const store = {
      listUsers: () => [],
      saveUser: async (user: StoredSystemUserRecord) => user,
      addAuditLog: async () => undefined
    } as unknown as MetadataStore;
    const app = Fastify();
    await registerServerMetaRoute(app, "server-test");
    await registerSystemRoutes(app, store, tmpdir());
    app.get("/api/meta/anything", async () => ({ leaked: true }));
    app.get("/api/protected", async () => ({ protected: true }));

    expect((await app.inject({ method: "GET", url: "/api/meta" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/meta/anything" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/protected" })).statusCode).toBe(401);
    await app.close();
  });
});
