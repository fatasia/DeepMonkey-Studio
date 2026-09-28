import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function fixture(modelOverrides: Partial<ModelRecord> = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bim-reconvert-")); directories.push(dataDir);
  const store = new JsonStore(dataDir); await store.init();
  const sourceBytes = Buffer.from("step-source-v1");
  const sourceUrl = "/assets/projects/default/models/model-1/source/bracket.step";
  await mkdir(path.join(dataDir, "projects", "default", "models", "model-1", "source"), { recursive: true });
  await writeFile(path.join(dataDir, "projects", "default", "models", "model-1", "source", "bracket.step"), sourceBytes);
  const model = {
    id: "model-1", projectId: "default", name: "bracket.step", format: "step", status: "ready",
    progress: 100, size: sourceBytes.byteLength, message: "ready", sourceUrl,
    createdAt: "2026-09-27", updatedAt: "2026-09-27", ...modelOverrides,
  } as ModelRecord;
  await store.addModel("default", model);
  const app = createApiServer(); await app.register(multipart);
  const queue = { enqueue: vi.fn(async () => "task-1"), listImportFormats: () => [] };
  const objects = { putFile: vi.fn(async () => undefined), removePrefix: vi.fn(async () => undefined) };
  await registerModelAssetRoutes(app, { store, queue: queue as never, objects: objects as never, dataDir, config: loadConfig() });
  const reconvert = async (bytes: string, name = "bracket.step") => {
    const data = new FormData(); data.append("file", new Blob([bytes]), name);
    const encoded = new Response(data);
    return app.inject({
      method: "POST", url: "/api/projects/default/models/model-1/reconvert",
      headers: { "content-type": encoded.headers.get("content-type")! },
      payload: Buffer.from(await encoded.arrayBuffer()),
    });
  };
  const storedSource = () => readFile(path.join(dataDir, "projects", "default", "models", "model-1", "source", "bracket.step"), "utf8");
  return { app, store, model, queue, objects, reconvert, storedSource, dataDir };
}

describe("reconvert route", () => {
  it("源文件变更时覆盖源、重新入队并置 queued", async () => {
    const f = await fixture();
    try {
      const response = await f.reconvert("step-source-v2");
      expect(response.statusCode).toBe(202);
      const result = response.json<ModelRecord>();
      expect(result.id).toBe("model-1");
      expect(result.status).toBe("queued");
      expect(result.message).toContain("重新转换");
      expect(await f.storedSource()).toBe("step-source-v2");
      expect(f.queue.enqueue).toHaveBeenCalledOnce();
      expect(f.queue.enqueue.mock.calls[0]![0].model.id).toBe("model-1");
      expect(f.objects.putFile).toHaveBeenCalledOnce();
    } finally { await f.app.close(); }
  });

  it("同源重传按内容判等直接返回，不重复转换", async () => {
    const f = await fixture();
    try {
      const response = await f.reconvert("step-source-v1");
      expect(response.statusCode).toBe(200);
      expect(response.json<ModelRecord>().status).toBe("ready");
      expect(response.json<ModelRecord>().message).toContain("未变化");
      expect(f.queue.enqueue).not.toHaveBeenCalled();
      expect((await f.storedSource())).toBe("step-source-v1");
    } finally { await f.app.close(); }
  });

  it("转换中拒绝再导入，格式不一致拒绝且不写任何字节", async () => {
    const f = await fixture({ status: "processing" });
    try {
      expect((await f.reconvert("step-source-v2")).statusCode).toBe(409);
      expect(f.queue.enqueue).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
    const g = await fixture();
    try {
      expect((await g.reconvert("glb-bytes", "other.glb")).statusCode).toBe(415);
      expect(g.queue.enqueue).not.toHaveBeenCalled();
      expect(await g.storedSource()).toBe("step-source-v1");
    } finally { await g.app.close(); }
  });
});
