import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import multipart from "@fastify/multipart";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PARAMETRIC_CAD_TEMPLATES } from "@bim-studio/parametric-modeling-plugin";
import { loadConfig } from "./config.js";
import { registerRoutes } from "./routes.js";
import { createApiServer } from "./serverOptions.js";
import { JsonStore } from "./store.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("parametric model upload", () => {
  it("persists strict generation evidence and queues the STEP conversion", async () => {
    const harness = await createHarness();
    const response = await injectMultipart(harness.app, "plate.step", generation());
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ format: "step", generation: { kind: "parametric", revision: 1, definition: { name: "设备安装板" } } });
    expect(harness.queue.enqueue).toHaveBeenCalledOnce();
    expect(harness.objects.putFile).toHaveBeenCalledOnce();
    await harness.app.close();
  });

  it("accepts GLB geometry with editable generation metadata", async () => {
    const harness = await createHarness();
    const response = await injectMultipart(harness.app, "plate.glb", generation());
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ format: "glb", generation: { kind: "parametric", revision: 1 } });
    expect(harness.queue.enqueue).toHaveBeenCalledOnce();
    await harness.app.close();
  });

  it("rejects unknown metadata fields and unsupported generated formats before persistence", async () => {
    const harness = await createHarness();
    const invalid = await injectMultipart(harness.app, "plate.step", { ...generation(), debug: true });
    const wrongFormat = await injectMultipart(harness.app, "plate.obj", generation());
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().message).toContain("未知字段");
    expect(wrongFormat.statusCode).toBe(400);
    expect(wrongFormat.json().message).toContain("STEP/STP");
    expect(harness.queue.enqueue).not.toHaveBeenCalled();
    await harness.app.close();
  });

  it("rejects stale device or simulation binding references", async () => {
    const harness = await createHarness();
    const metadata = generation();
    metadata.definition = structuredClone(metadata.definition);
    metadata.definition.semanticBindings![0]!.target = {
      kind: "simulation-signal", connectionId: "missing", datasetId: "missing", field: "stroke"
    };
    const response = await injectMultipart(harness.app, "plate.step", metadata);
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("运行绑定已失效");
    expect(harness.queue.enqueue).not.toHaveBeenCalled();
    await harness.app.close();
  });
});

async function createHarness() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bim-parametric-route-"));
  directories.push(dataDir);
  const store = new JsonStore(dataDir);
  await store.init();
  const app = createApiServer();
  const queue = { enqueue: vi.fn() };
  const objects = { putFile: vi.fn(async () => undefined), removePrefix: vi.fn(async () => undefined) };
  // 路由测试应复用生产入口的 multipart 能力，避免把插件缺失误判为业务校验失败。
  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 1 } });
  await registerRoutes(app, { store, queue: queue as never, objects: objects as never, dataDir, config: loadConfig() });
  return { app, queue, objects };
}

async function injectMultipart(app: Awaited<ReturnType<typeof createApiServer>>, fileName: string, metadata: unknown) {
  const form = new FormData();
  form.append("generation", JSON.stringify(metadata));
  form.append("file", new Blob(["ISO-10303-21;END-ISO-10303-21;"], { type: "model/step" }), fileName);
  const encoded = new Response(form);
  return app.inject({ method: "POST", url: "/api/projects/default/models", headers: { "content-type": encoded.headers.get("content-type")! }, payload: Buffer.from(await encoded.arrayBuffer()) });
}

function generation() {
  return {
    kind: "parametric", generatorId: "bim.parametric-modeling", generatorVersion: "1.0.0",
    definition: PARAMETRIC_CAD_TEMPLATES[0]!.definition, revision: 1, generatedAt: "2026-08-28T00:00:00.000Z",
    build: { durationMs: 120, volumeMm3: 100, faceCount: 6, edgeCount: 12, triangleCount: 24, bounds: [[0, 0, 0], [10, 10, 10]], warnings: [] }
  };
}
