import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import multipart from "@fastify/multipart";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRecord } from "@bim-studio/contracts";
import { createApiServer } from "./serverOptions.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import { registerModelAssetRoutes } from "./modelAssetRoutes.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bim-optimization-upload-")); directories.push(dataDir);
  const store = new JsonStore(dataDir); await store.init();
  const source = { id: "source", projectId: "default", name: "original.glb", format: "glb", status: "ready", progress: 100, size: 4, message: "ready", sourceUrl: "/assets/original.glb", createdAt: "2026-09-05", updatedAt: "2026-09-05", libraryOrigin: { itemId: "licensed", contentHash: "original-hash", catalogVersion: 1, license: "CC-BY-4.0" } } as ModelRecord;
  await store.addModel("default", source);
  const app = createApiServer(); await app.register(multipart);
  const queue = { enqueue: vi.fn() }; const objects = { putFile: vi.fn(async () => undefined), removePrefix: vi.fn(async () => undefined) };
  await registerModelAssetRoutes(app, { store, queue: queue as never, objects: objects as never, dataDir, config: loadConfig() });
  const upload = async (sourceId: string, name = "optimized.glb") => {
    const data = new FormData(); data.append("file", new Blob(["queue fixture"]), name);
    const encoded = new Response(data);
    return app.inject({ method: "POST", url: `/api/projects/default/models?optimizedFromModelId=${encodeURIComponent(sourceId)}`, headers: { "content-type": encoded.headers.get("content-type")! }, payload: Buffer.from(await encoded.arrayBuffer()) });
  };
  return { app, store, source, queue, objects, upload };
}
describe("optimized model upload route", () => {
  it("queues a new model and persists authoritative source credit without overwriting the original", async () => {
    const f = await fixture();
    try {
      const response = await f.upload("source"); expect(response.statusCode).toBe(202);
      const result = response.json<ModelRecord>();
      expect(result.id).not.toBe(f.source.id); expect(result.libraryOrigin).toBeUndefined();
      expect(result.optimization).toEqual({ sourceModelId: "source", sourceModelName: f.source.name, sourceUpdatedAt: f.source.updatedAt, libraryOrigin: f.source.libraryOrigin });
      expect(f.store.getProject("default")?.models.find(model => model.id === f.source.id)).toEqual(f.source);
      expect(f.queue.enqueue).toHaveBeenCalledOnce(); expect(f.objects.putFile).toHaveBeenCalledOnce();
    } finally { await f.app.close(); }
  });
  it("rejects a missing source or wrong output format before storing any bytes", async () => {
    const f = await fixture();
    try {
      expect((await f.upload("other-project-model")).statusCode).toBe(400);
      expect((await f.upload("source", "fake.step")).statusCode).toBe(400);
      expect(f.queue.enqueue).not.toHaveBeenCalled(); expect(f.objects.putFile).not.toHaveBeenCalled();
      expect(f.store.getProject("default")?.models).toHaveLength(1);
    } finally { await f.app.close(); }
  });
});
