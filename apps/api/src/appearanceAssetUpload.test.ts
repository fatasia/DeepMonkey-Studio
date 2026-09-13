import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import multipart from "@fastify/multipart";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { registerRoutes } from "./routes.js";
import { createApiServer } from "./serverOptions.js";
import { JsonStore } from "./store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

describe("project appearance uploads", () => {
  it("persists environment and PBR maps through restart, rename and deletion", async () => {
    const { app, store, dataDir, objects } = await harness();
    try {
      const environment = await upload(app, "environment-maps", [["file", "sky.png", png]]);
      expect(environment.statusCode).toBe(201);
      expect(environment.json()).toMatchObject({ kind: "environment", projectId: "default", maps: [{ kind: "environment", size: png.length }] });
      const material = await upload(app, "assets/materials", [["base-color", "钢板.png", png], ["normal", "normal.png", png]]);
      expect(material.statusCode).toBe(201);
      expect(material.json()).toMatchObject({ kind: "pbr-material", size: png.length * 2, maps: [{ kind: "base-color" }, { kind: "normal" }] });
      expect(objects.putFile).toHaveBeenCalledTimes(3);
      const map = material.json().maps[0];
      expect(await readFile(path.join(dataDir, decodeURIComponent(map.url.slice("/assets/".length))))).toEqual(png);
      const restored = new JsonStore(dataDir); await restored.init();
      expect(restored.listAssets("default")).toHaveLength(2);
      expect(restored.listAssets("default").find(asset => asset.id === material.json().id)?.maps).toEqual(material.json().maps);
      const renamed = await app.inject({ method: "PATCH", url: `/api/projects/default/assets/${material.json().id}`, payload: { name: "测试钢板" } });
      expect(renamed.json().name).toBe("测试钢板");
      const deleted = await app.inject({ method: "DELETE", url: `/api/projects/default/assets/${material.json().id}` });
      expect(deleted.statusCode).toBe(204);
      expect(store.listAssets("default")).toHaveLength(1);
      expect(objects.removePrefix).toHaveBeenCalledWith(`projects/default/assets/${material.json().id}`);
    } finally { await app.close(); }
  });

  it("rejects missing base color, duplicate roles, wrong formats and empty files without orphan records", async () => {
    const { app, store, dataDir } = await harness();
    try {
      for (const files of [
        [["normal", "normal.png", png]],
        [["base-color", "one.png", png], ["base-color", "two.png", png]],
        [["base-color", "script.js", png]],
        [["base-color", "empty.png", Buffer.alloc(0)]],
        [["unknown", "one.png", png]],
      ] as FilePart[][]) {
        expect((await upload(app, "assets/materials", files)).statusCode).toBe(400);
        expect(store.listAssets("default")).toHaveLength(0);
      }
      expect(await readdir(path.join(dataDir, "projects/default/assets"))).toEqual([]);
      expect((await upload(app, "assets/materials", [["base-color", "base.png", png]], "missing")).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it("rolls back stored maps when object persistence fails and allows a clean retry", async () => {
    const { app, store, dataDir, objects } = await harness();
    try {
      objects.putFile.mockRejectedValueOnce(new Error("object storage unavailable"));
      expect((await upload(app, "assets/materials", [["base-color", "base.png", png]])).statusCode).toBe(400);
      expect(store.listAssets("default")).toHaveLength(0);
      expect(await readdir(path.join(dataDir, "projects/default/assets"))).toEqual([]);
      expect(objects.removePrefix).toHaveBeenCalledOnce();
      expect((await upload(app, "assets/materials", [["base-color", "base.png", png]])).statusCode).toBe(201);
      expect(store.listAssets("default")).toHaveLength(1);
    } finally { await app.close(); }
  });
});

async function harness() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bim-appearance-upload-")); roots.push(dataDir);
  const store = new JsonStore(dataDir); await store.init();
  const app = createApiServer();
  const objects = { putFile: vi.fn(async () => undefined), removePrefix: vi.fn(async () => undefined) };
  await app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024, files: 1 } });
  await registerRoutes(app, { store, queue: { enqueue: vi.fn() } as never, objects: objects as never, dataDir, config: loadConfig() });
  return { app, store, dataDir, objects };
}
type FilePart = [string, string, Buffer];
async function upload(app: ReturnType<typeof createApiServer>, route: string, files: FilePart[], project = "default") {
  const form = new FormData();
  for (const [role, name, bytes] of files) form.append(role, new Blob([bytes]), name);
  const encoded = new Response(form);
  return app.inject({ method: "POST", url: `/api/projects/${project}/${route}`, headers: { "content-type": encoded.headers.get("content-type")! }, payload: Buffer.from(await encoded.arrayBuffer()) });
}
