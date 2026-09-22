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
import { minimalXtRevolvedSubsetFixture } from "./fixtures/minimalXtRevolvedSubset.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("industrial format upload acceptance without providers", () => {
  it.each([
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
    expect(model.message).toContain("内置离线解析 profile 尚未就绪");
    // 需要规范化的格式在转换完成前不暴露源格式预览，避免运行时双几何切换。
    expect(model.manifest).toBeUndefined();
    expect(model.manifestUrl).toBeUndefined();

    const sourcePath = path.join(dataDir, "projects", "default", "models", uploaded.id, "source", fileName);
    expect(await readFile(sourcePath, "utf8")).toBe(content);
    expect(await objects.stat(`projects/default/models/${uploaded.id}/source/${fileName}`)).toBe(true);
    await app.close();
  });

  it.each(["part.x_b"])(
    "does not run an external fallback for unsupported %s even if its command is configured",
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
        expect(store.getProject("default")?.models.find((item) => item.id === uploaded.id)?.status).toBe("waiting_converter");
      });
      const model = store.getProject("default")!.models.find((item) => item.id === uploaded.id)!;
      expect(model.manifest).toBeUndefined();
      expect(queue.tasks.get("default", model.conversionTaskId!)?.quality?.tier).toBe("inspect");
      const outputDir = path.join(dataDir, "projects", "default", "models", uploaded.id, "attempts", model.conversionTaskId!, "output");
      await expect(readFile(path.join(outputDir, "geometry.glb"))).rejects.toMatchObject({ code: "ENOENT" });
      await app.close();
    },
  );

  it("does not launch a configured industrial executable for a blocked binary profile", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-industrial-timeout-"));
    directories.push(dataDir);
    const store = new JsonStore(dataDir);
    await store.init();
    const objects = new LocalObjectStore(dataDir);
    const config = loadConfig();
    config.dataDir = dataDir;
    config.industrialCad = {
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10_000)"],
      cwd: process.cwd(),
      timeoutMs: 25,
    };
    const queue = new ConversionQueue(store, config, objects);
    const app = createApiServer();
    await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
    await registerModelAssetRoutes(app, { store, queue, objects, dataDir, config });

    const response = await upload(app, "hung.x_b", "timeout fixture");
    const uploaded = response.json() as ModelRecord;
    await vi.waitFor(() => {
      expect(store.getProject("default")?.models.find((item) => item.id === uploaded.id)?.status).toBe("waiting_converter");
    }, { timeout: 2_000, interval: 25 });
    expect(store.getProject("default")!.models.find((item) => item.id === uploaded.id)?.message).toContain("内置离线解析");
    await app.close();
  });

  it("converts the supported X_T text subset without an external provider", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-xt-internal-"));
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

    const content = new TextDecoder().decode(minimalXtRevolvedSubsetFixture());
    const response = await upload(app, "rotor.x_t", content);
    const uploaded = response.json() as ModelRecord;
    await vi.waitFor(() => {
      expect(store.getProject("default")?.models.find((item) => item.id === uploaded.id)?.status).toBe("ready");
    });
    const model = store.getProject("default")!.models.find((item) => item.id === uploaded.id)!;
    expect(model.manifest).toMatchObject({
      sourceFormat: "x_t",
      viewerKind: "gltf",
      inspectionUrl: expect.stringContaining("inspection.json"),
    });
    expect(model.message).toContain("10 个面");
    const outputDir = path.join(dataDir, "projects", "default", "models", uploaded.id, "attempts", model.conversionTaskId!, "output");
    expect(await auditGlbGeometry(path.join(outputDir, "geometry.glb"))).toMatchObject({
      meshCount: 10,
      primitiveCount: 10,
      triangleCount: 4224,
    });
    expect(JSON.parse(await readFile(path.join(outputDir, "hierarchy.json"), "utf8"))).toHaveProperty("root");
    expect(JSON.parse(await readFile(path.join(outputDir, "inspection.json"), "utf8"))).toMatchObject({
      status: "geometry-supported",
      geometryParsed: true,
    });
    await app.close();
  });

  it("keeps another X_T schema as structure-read without publishing fallback geometry", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-xt-structure-only-"));
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

    const content = new TextDecoder().decode(minimalXtRevolvedSubsetFixture())
      .replaceAll("SCH_2401231_20000_1300", "SCH_2500000_20000_1300")
      .replaceAll("SCH_2401231_20000", "SCH_2500000_20000");
    const response = await upload(app, "future.x_t", content);
    const uploaded = response.json() as ModelRecord;
    await vi.waitFor(() => {
      expect(store.getProject("default")?.models.find((item) => item.id === uploaded.id)?.status).toBe("waiting_converter");
    });

    const model = store.getProject("default")!.models.find((item) => item.id === uploaded.id)!;
    expect(model.message).toContain("SCH_2500000_20000_1300 头部已读取");
    expect(model.manifest).toMatchObject({
      sourceFormat: "x_t",
      inspectionUrl: expect.stringContaining("inspection.json"),
    });
    expect(model.manifest?.geometryUrl).toBeUndefined();
    const outputDir = path.join(dataDir, "projects", "default", "models", uploaded.id, "attempts", model.conversionTaskId!, "output");
    expect(JSON.parse(await readFile(path.join(outputDir, "inspection.json"), "utf8"))).toMatchObject({
      status: "structure-read",
      geometryParsed: false,
      topology: { bodies: { status: "not-decoded" }, shells: { status: "not-decoded" } },
    });
    await expect(readFile(path.join(outputDir, "geometry.glb"))).rejects.toMatchObject({ code: "ENOENT" });
    await app.close();
  });

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
