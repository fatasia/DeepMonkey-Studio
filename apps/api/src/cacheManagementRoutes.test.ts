import Fastify from "fastify";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SystemUserRecord } from "@bim-studio/contracts";
import { registerCacheManagementRoutes } from "./cacheManagementRoutes.js";
import { ThreeSceneViewerCache } from "./threeSceneViewerCache.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "packaging-cache-test-")); roots.push(root);
  const directory = path.join(root, ".cache", "three-scene-viewer-v1");
  await mkdir(directory, { recursive: true });
  const cache = new ThreeSceneViewerCache(directory);
  const app = Fastify();
  app.addHook("preHandler", async request => {
    const role = request.headers["x-test-role"];
    if (role) request.systemUser = { role } as SystemUserRecord;
  });
  registerCacheManagementRoutes(app, cache);
  const file = (name: string) => path.join(directory, name);
  return { app, cache, file, root, directory };
}
const url = "/api/admin/cache/three-scene-viewer";
const headers = { "x-test-role": "admin" };

describe("server packaging cache management", () => {
  it("requires authentication and admin role for inspection and deletion", async () => {
    const f = await fixture();
    for (const method of ["GET", "DELETE"] as const) {
      expect((await f.app.inject({ method, url })).statusCode).toBe(401);
      expect((await f.app.inject({ method, url, headers: { "x-test-role": "viewer" } })).statusCode).toBe(403);
    }
    await f.app.close();
  });

  it("reports exact bytes, deletes only hash-named copies and preserves frozen/temporary files", async () => {
    const f = await fixture();
    await writeFile(f.file(`${"a".repeat(64)}.exe`), Buffer.alloc(137));
    await writeFile(f.file("building.tmp"), "pending");
    const frozen = path.join(f.root, "published.exe"); await writeFile(frozen, "published");
    await link(frozen, f.file(`${"b".repeat(64)}.exe`));
    await mkdir(f.file("nested"));
    const before = await f.app.inject({ url, headers });
    expect(before.json()).toMatchObject({ entries: 1, bytes: 137, skippedEntries: 3 });
    expect(before.headers["cache-control"]).toBe("no-store");
    const cleared = await f.app.inject({ method: "DELETE", url, headers });
    expect(cleared.json()).toMatchObject({ removedEntries: 1, removedBytes: 137, skippedEntries: 3 });
    expect(await readFile(frozen, "utf8")).toBe("published");
    expect(await readFile(f.file("building.tmp"), "utf8")).toBe("pending");
    expect((await f.app.inject({ method: "DELETE", url, headers })).json().removedBytes).toBe(0);
    await f.app.close();
  });

  it("queues cleanup after an active build and continues after an earlier failure", async () => {
    const f = await fixture();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const building = f.cache.exclusive(async () => { await barrier; await writeFile(f.file(`${"c".repeat(64)}.exe`), "built"); });
    let finished = false;
    const clearing = f.cache.clear().then(result => { finished = true; return result; });
    await Promise.resolve(); expect(finished).toBe(false);
    release(); await building;
    expect(await clearing).toMatchObject({ removedEntries: 1, removedBytes: 5 });
    await expect(f.cache.exclusive(async () => { throw new Error("build failed"); })).rejects.toThrow("build failed");
    expect(await f.cache.inspect()).toMatchObject({ entries: 0 });
    await f.app.close();
  });

  it("rejects a junction cache directory and leaves the target intact", async () => {
    const f = await fixture();
    const elsewhere = path.join(f.root, "published"); await mkdir(elsewhere);
    const frozen = path.join(elsewhere, `${"d".repeat(64)}.exe`); await writeFile(frozen, "keep");
    await rm(f.directory, { recursive: true });
    await symlink(elsewhere, f.directory, "junction");
    const result = await f.app.inject({ method: "DELETE", url, headers });
    expect(result.statusCode).toBe(500);
    expect(await readFile(frozen, "utf8")).toBe("keep");
    await f.app.close();
  });
});
