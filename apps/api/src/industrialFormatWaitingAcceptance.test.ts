import multipart from "@fastify/multipart";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRecord } from "@bim-studio/contracts";
import { loadConfig } from "./config.js";
import { ConversionQueue } from "./conversion.js";
import { JsonStore } from "./jsonStore.js";
import { registerModelAssetRoutes } from "./modelAssetRoutes.js";
import { LocalObjectStore } from "./objects.js";
import { createApiServer } from "./serverOptions.js";
import { auditGlbGeometry } from "./converterOutputAudit.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("industrial format upload acceptance without providers", () => {
  it.each([
    ["minimal.jt", "Version 10.5 JT\nsynthetic structure-only fixture"],
    ["minimal.x_t", "**ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz*****************\nPARASOLID text fixture"],
    ["minimal.x_b", "PARASOLID neutral binary fixture"],
  ])("preserves %s and reports waiting_converter without inventing geometry", async (fileName, content) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-industrial-waiting-"));
    directories.push(dataDir);
    const store = new JsonStore(dataDir);
    await store.init();
    const objects = new LocalObjectStore(dataDir);
    const config = loadConfig();
    config.dataDir = dataDir;
    config.industrialCad = { args: [], cwd: process.cwd() };
    const queue = new ConversionQueue(store, config, objects);
    const app = createApiServer();
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
    await registerModelAssetRoutes(app, { store, queue, objects, dataDir, config });

    const response = await upload(app, fileName, content);
    expect(response.statusCode).toBe(202);
    const uploaded = response.json() as ModelRecord;
    await vi.waitFor(() => {
      expect(store.getProject("default")?.models.find((item) => item.id === uploaded.id)?.status).toBe("waiting_converter");
    });
    const model = store.getProject("default")!.models.find((item) => item.id === uploaded.id)!;
    expect(model).toMatchObject({ status: "waiting_converter", progress: 0 });
    expect(model.message).toContain("未配置");
    // 需要规范化的格式在转换完成前不暴露源格式预览，避免运行时双几何切换。
    expect(model.manifest).toBeUndefined();
    expect(model.manifestUrl).toBeUndefined();

    const sourcePath = path.join(dataDir, "projects", "default", "models", uploaded.id, "source", fileName);
    expect(await readFile(sourcePath, "utf8")).toBe(content);
    expect(await objects.stat(`projects/default/models/${uploaded.id}/source/${fileName}`)).toBe(true);
    await app.close();
  });

  it.each(["assembly.jt", "part.x_t", "part.x_b"])(
    "runs the complete %s plumbing through a synthetic provider and audits its GLB cache",
    async (fileName) => {
      const dataDir = await mkdtemp(path.join(tmpdir(), "bim-industrial-plumbing-"));
      directories.push(dataDir);
      const store = new JsonStore(dataDir);
      await store.init();
      const objects = new LocalObjectStore(dataDir);
      const config = loadConfig();
      const fixture = fileURLToPath(new URL("./fixtures/fakeCadConverter.mjs", import.meta.url));
      const args = [fixture, "--input", "{input}", "--output", "{output}", "--format", "{format}", "--include-pmi", "{includePmi}"];
      config.dataDir = dataDir;
      config.industrialCad = { command: process.execPath, args, cwd: process.cwd() };
      const queue = new ConversionQueue(store, config, objects);
      const app = createApiServer();
      await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
      await registerModelAssetRoutes(app, { store, queue, objects, dataDir, config });

      const response = await upload(app, fileName, "transport fixture; synthetic provider does not parse source geometry");
      const uploaded = response.json() as ModelRecord;
      await vi.waitFor(() => {
        expect(store.getProject("default")?.models.find((item) => item.id === uploaded.id)?.status).toBe("ready");
      });
      const model = store.getProject("default")!.models.find((item) => item.id === uploaded.id)!;
      expect(model.manifest).toMatchObject({ sourceFormat: model.format, viewerKind: "gltf" });
      expect(model.manifest?.geometryUrl).toContain("/output/geometry.glb");
      const outputDir = path.join(dataDir, "projects", "default", "models", uploaded.id, "output");
      expect(await auditGlbGeometry(path.join(outputDir, "geometry.glb"))).toEqual({
        meshCount: 1, primitiveCount: 1, vertexCount: 3, triangleCount: 1,
      });
      expect(JSON.parse(await readFile(path.join(outputDir, "hierarchy.json"), "utf8"))).toHaveProperty("nodes");
      expect(JSON.parse(await readFile(path.join(outputDir, "properties.json"), "utf8"))).toHaveProperty("sourceFormat", model.format);
      expect(JSON.parse(await readFile(path.join(outputDir, "pmi.json"), "utf8"))).toHaveProperty("annotations");
      await app.close();
    },
  );

  it.each([
    ["scene.usd", "#usda 1.0\n\ndef Sphere \"sphere\" {}\n"],
    ["scene.usda", "#usda 1.0\n\ndef Sphere \"sphere\" {}\n"],
    ["scene.usdc", "PXR-USDC fixture transport"],
    ["scene.usdz", "PK fixture transport"],
  ])("publishes %s directly for the official browser loader without an external provider", async (fileName, content) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-openusd-direct-"));
    directories.push(dataDir);
    const store = new JsonStore(dataDir);
    await store.init();
    const objects = new LocalObjectStore(dataDir);
    const config = loadConfig();
    config.dataDir = dataDir;
    const queue = new ConversionQueue(store, config, objects);
    const app = createApiServer();
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
    await registerModelAssetRoutes(app, { store, queue, objects, dataDir, config });

    const response = await upload(app, fileName, content);
    const uploaded = response.json() as ModelRecord;
    await vi.waitFor(() => {
      expect(store.getProject("default")?.models.find((item) => item.id === uploaded.id)?.status).toBe("ready");
    });
    const model = store.getProject("default")!.models.find((item) => item.id === uploaded.id)!;
    expect(model.manifest).toMatchObject({
      sourceFormat: model.format,
      viewerKind: "usd",
      geometryUrl: model.sourceUrl,
    });
    expect(model.message).toBe("可查看");
    await app.close();
  });
});

async function upload(
  app: ReturnType<typeof createApiServer>,
  fileName: string,
  content: string,
) {
  const form = new FormData();
  form.append("file", new Blob([content], { type: "application/octet-stream" }), fileName);
  const encoded = new Response(form);
  return app.inject({
    method: "POST",
    url: "/api/projects/default/models",
    headers: { "content-type": encoded.headers.get("content-type")! },
    payload: Buffer.from(await encoded.arrayBuffer()),
  });
}
