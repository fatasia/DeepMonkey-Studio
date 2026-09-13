import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import multipart from "@fastify/multipart";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiServer } from "./serverOptions.js";
import { JsonStore } from "./store.js";
import { registerResourceThumbnailRoutes } from "./resourceThumbnailRoutes.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("resource thumbnail persistence", () => {
  it("saves decoded covers for models and media, preserving source files after restart", async () => {
    const h = await harness();
    try {
      for (const kind of ["models", "assets"] as const) {
        const result = await h.upload(kind, h.png);
        expect(result.statusCode).toBe(200);
        const saved = result.json();
        expect(saved.thumbnailUrl).toMatch(/\/thumbnails\/[^/]+\.webp$/);
        const bytes = await readFile(path.join(h.root, saved.thumbnailUrl.slice("/assets/".length)));
        expect(await sharp(bytes).metadata()).toMatchObject({ width: 640, height: 480, format: "webp" });
        const restored = new JsonStore(h.root); await restored.init();
        const item = kind === "models" ? restored.getProject("default")!.models[0] : restored.listAssets("default")[0];
        expect(item).toMatchObject({ thumbnailUrl: saved.thumbnailUrl, name: "original" });
      }
      expect(h.store.getProject("default")!.models[0]!.sourceUrl).toBe("/original.glb");
      expect(h.store.listAssets("default")[0]!.url).toBe("/original.png");
    } finally { await h.app.close(); }
  });
  it("rejects fake images, excessive bytes and unknown resources before storing anything", async () => {
    const h = await harness();
    try {
      expect((await h.upload("models", Buffer.from("not a png"))).statusCode).toBe(400);
      expect((await h.upload("models", Buffer.alloc(8 * 1024 * 1024 + 1))).statusCode).toBe(400);
      expect((await h.upload("models", h.png, "missing")).statusCode).toBe(404);
      expect(h.objects.putFile).not.toHaveBeenCalled();
    } finally { await h.app.close(); }
  });
  it("retains the previous thumbnail on storage failure, then uses a fresh URL on retry", async () => {
    const h = await harness();
    try {
      const first = (await h.upload("assets", h.png)).json();
      h.objects.putFile.mockRejectedValueOnce(new Error("offline"));
      expect((await h.upload("assets", h.png)).statusCode).toBe(503);
      expect(h.store.listAssets("default")[0]!.thumbnailUrl).toBe(first.thumbnailUrl);
      expect(h.objects.removePrefix).toHaveBeenCalledOnce();
      expect((await h.upload("assets", h.png)).json().thumbnailUrl).not.toBe(first.thumbnailUrl);
    } finally { await h.app.close(); }
  });
  it("merges a concurrent rename without restoring deleted resources", async () => {
    const h = await harness();
    try {
      h.objects.putFile.mockImplementationOnce(async () => { const current = h.store.listAssets("default")[0]!; await h.store.saveAsset("default", { ...current, name: "renamed" }); });
      expect((await h.upload("assets", h.png)).json().name).toBe("renamed");
      h.objects.putFile.mockImplementationOnce(async () => { await h.store.removeAsset("default", "resource"); });
      expect((await h.upload("assets", h.png)).statusCode).toBe(503);
      expect(h.store.listAssets("default")).toHaveLength(0);
    } finally { await h.app.close(); }
  });
});

async function harness() {
  const root = await mkdtemp(path.join(tmpdir(), "bim-thumbnail-")); roots.push(root);
  const store = new JsonStore(root); await store.init();
  const now = new Date().toISOString();
  await store.addModel("default", { id: "resource", projectId: "default", name: "original", format: "glb", size: 30, status: "ready", progress: 100, message: "", sourceUrl: "/original.glb", createdAt: now, updatedAt: now });
  await store.saveAsset("default", { id: "resource", projectId: "default", name: "original", kind: "image", fileName: "original.png", mimeType: "image/png", size: 10, url: "/original.png", createdAt: now, updatedAt: now });
  const objects = { putFile: vi.fn(async () => undefined), removePrefix: vi.fn(async () => undefined) };
  const app = createApiServer(); await app.register(multipart);
  registerResourceThumbnailRoutes(app, { store, objects: objects as never, dataDir: root });
  const png = await sharp({ create: { width: 800, height: 600, channels: 3, background: "teal" } }).png().toBuffer();
  const upload = async (kind: string, bytes: Buffer, id = "resource") => {
    const form = new FormData(); form.append("file", new Blob([bytes]), "cover.png"); const encoded = new Response(form);
    return app.inject({ method: "POST", url: `/api/projects/default/${kind}/${id}/thumbnail`, headers: { "content-type": encoded.headers.get("content-type")! }, payload: Buffer.from(await encoded.arrayBuffer()) });
  };
  return { root, store, objects, app, png, upload };
}
