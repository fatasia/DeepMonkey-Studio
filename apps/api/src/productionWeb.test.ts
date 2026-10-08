import Fastify from "fastify";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerProductionWeb } from "./productionWeb.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production web hosting", () => {
  it("serves hashed Vite assets ahead of the object wildcard while retaining project objects", async () => {
    const root = await createWebRoot();
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets/index-a1b2c3.js"), "console.log('bundle')");
    await writeFile(path.join(root, "assets/index-a1b2c3.js.br"), "compressed-bundle");
    const app = Fastify();
    app.get<{ Params: { "*": string } }>("/assets/*", async (request, reply) =>
      request.params["*"] === "projects/project/model.glb" ? "project-model" : reply.code(404).send("object-missing"));
    await registerProductionWeb(app, { enabled: true, root });
    const bundle = await app.inject({ url: "/assets/index-a1b2c3.js" });
    expect(bundle.statusCode).toBe(200); expect(bundle.body).toBe("console.log('bundle')");
    const compressed = await app.inject({ url: "/assets/index-a1b2c3.js", headers: { "accept-encoding": "br" } });
    expect(compressed.headers["content-encoding"]).toBe("br"); expect(compressed.body).toBe("compressed-bundle");
    expect((await app.inject({ url: "/assets/projects/project/model.glb" })).body).toBe("project-model");
    expect((await app.inject({ url: "/assets/not-a-build.js" })).statusCode).toBe(404);
    await app.close();
  });
  it("serves bundled assets and falls back to the SPA entry", async () => {
    const root = await createWebRoot();
    const app = Fastify();
    await registerProductionWeb(app, { enabled: true, root });

    expect((await app.inject({ url: "/asset.js" })).body).toBe("console.log('ready')");
    const route = await app.inject({ url: "/published/application-1", headers: { accept: "text/html" } });
    expect(route.statusCode).toBe(200);
    expect(route.body).toContain("viewer-shell");
    await app.close();
  });

  it("serves brotli sidecars when accepted and raw bytes otherwise", async () => {
    const root = await createWebRoot();
    await writeFile(path.join(root, "asset.js.br"), "brotli-bytes");
    const app = Fastify();
    await registerProductionWeb(app, { enabled: true, root });

    const compressed = await app.inject({ url: "/asset.js", headers: { "accept-encoding": "br, gzip" } });
    expect(compressed.statusCode).toBe(200);
    expect(compressed.headers["content-encoding"]).toBe("br");
    expect(compressed.body).toBe("brotli-bytes");

    const plain = await app.inject({ url: "/asset.js" });
    expect(plain.statusCode).toBe(200);
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.body).toBe("console.log('ready')");
    await app.close();
  });

  it("does not turn unknown API routes into HTML", async () => {
    const root = await createWebRoot();
    const app = Fastify();
    await registerProductionWeb(app, { enabled: true, root });

    const response = await app.inject({ url: "/api/missing", headers: { accept: "text/html" } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ message: "请求的资源不存在" });
    await app.close();
  });
});

async function createWebRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bim-production-web-"));
  temporaryDirectories.push(root);
  await writeFile(path.join(root, "index.html"), "<!doctype html><main>viewer-shell</main>");
  await writeFile(path.join(root, "asset.js"), "console.log('ready')");
  return root;
}
