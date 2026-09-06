import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import multipart from "@fastify/multipart";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRecord, RobotAssetDefinition } from "@bim-studio/contracts";
import { createApiServer } from "./serverOptions.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import { registerModelAssetRoutes } from "./modelAssetRoutes.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) {
  if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith("bim-robot-upload-")) throw new Error("invalid test directory");
  await rm(directory, { recursive: true, force: true });
} });
async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bim-robot-upload-")); directories.push(dataDir);
  const store = new JsonStore(dataDir); await store.init();
  const app = createApiServer(); await app.register(multipart, { limits: { fileSize: 16 * 1024 * 1024 } });
  const queue = { enqueue: vi.fn() }; const objects = { putFile: vi.fn(async () => undefined) };
  await registerModelAssetRoutes(app, { store, queue: queue as never, objects: objects as never, dataDir, config: loadConfig() });
  const upload = async (name: string, fields: string[] = [], afterFile = false, sourceId?: string, bytes: string | Uint8Array = "robot source") => {
    const data = new FormData();
    if (!afterFile) for (const value of fields) data.append("robotEntryPath", value);
    data.append("file", new Blob([bytes as BlobPart]), name);
    if (afterFile) for (const value of fields) data.append("robotEntryPath", value);
    const encoded = new Response(data);
    return app.inject({ method: "POST", url: `/api/projects/default/models${sourceId ? `?optimizedFromModelId=${encodeURIComponent(sourceId)}` : ""}`,
      headers: { "content-type": encoded.headers.get("content-type")! }, payload: Buffer.from(await encoded.arrayBuffer()) });
  };
  return { app, store, dataDir, queue, objects, upload };
}

describe("robot upload route", () => {
  it.each([false, true])("preserves a selected entry with fields after file = %s", async afterFile => {
    const f = await fixture();
    try {
      const response = await f.upload("robot.zip", ["pkg/main.urdf"], afterFile);
      expect(response.statusCode).toBe(202); expect(response.json<ModelRecord>()).toMatchObject({ format: "zip", robotEntryPath: "pkg/main.urdf", status: "queued" });
      expect(f.queue.enqueue).toHaveBeenCalledOnce(); expect(f.objects.putFile).toHaveBeenCalledOnce();
    } finally { await f.app.close(); }
  });
  it("accepts standalone URDF without an entry field", async () => {
    const f = await fixture();
    try { expect((await f.upload("arm.urdf")).statusCode).toBe(202); }
    finally { await f.app.close(); }
  });
  it.each([
    ["robot.zip", ["../main.urdf"]], ["robot.zip", ["a.urdf", "b.urdf"]],
    ["robot.zip", ["mesh.stl"]], ["mesh.glb", ["main.urdf"]],
  ])("rejects invalid entry metadata %s %j without queue or object writes", async (name, fields) => {
    const f = await fixture();
    try {
      expect((await f.upload(name, fields)).statusCode).toBe(400);
      expect(f.queue.enqueue).not.toHaveBeenCalled(); expect(f.objects.putFile).not.toHaveBeenCalled();
      expect(f.store.getProject("default")!.models).toHaveLength(0);
    } finally { await f.app.close(); }
  });
  it("rejects oversized XML during upload and removes the partial file", async () => {
    const f = await fixture();
    try {
      const response = await f.upload("large.urdf", [], false, undefined, new Uint8Array(8 * 1024 * 1024 + 1));
      expect(response.statusCode).toBe(413); expect(response.json().message).toContain("8 MiB");
      expect(f.queue.enqueue).not.toHaveBeenCalled(); expect(f.objects.putFile).not.toHaveBeenCalled();
      const modelsPath = path.join(f.dataDir, "projects", "default", "models");
      for (const model of await readdir(modelsPath)) expect(await readdir(path.join(modelsPath, model, "source"))).toEqual([]);
    } finally { await f.app.close(); }
  });
  it("allows only ZIP optimization for a robot and preserves existing provenance", async () => {
    const f = await fixture();
    try {
      const source: ModelRecord = { id: "robot", projectId: "default", name: "robot.urdf", format: "urdf", status: "ready", progress: 100,
        message: "ready", size: 1, sourceUrl: "/assets/robot.urdf", createdAt: "2026-09-06", updatedAt: "2026-09-06",
        manifest: { schemaVersion: 1, modelId: "robot", sourceName: "robot.urdf", sourceFormat: "urdf", viewerKind: "urdf", geometryUrl: "/assets/robot.urdf", createdAt: "2026-09-06", robot: { entryPath: "robot.urdf" } as RobotAssetDefinition } };
      await f.store.addModel("default", source);
      expect((await f.upload("flattened.glb", [], false, "robot")).statusCode).toBe(400);
      const compressed = await f.upload("robot.zip", [], false, "robot");
      expect(compressed.statusCode).toBe(202);
      expect(compressed.json<ModelRecord>().optimization).toMatchObject({ sourceModelId: "robot", sourceUpdatedAt: source.updatedAt });
      expect(f.store.getProject("default")!.models[0]).toEqual(source);
    } finally { await f.app.close(); }
  });
});
