import multipart from "@fastify/multipart";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelRecord } from "@bim-studio/contracts";
import { loadConfig } from "./config.js";
import { ConversionQueue } from "./conversion.js";
import { JsonStore } from "./jsonStore.js";
import {
  assetObjectKey,
  MODEL_STRUCTURE_NODE_LIMIT,
  parseStructurePropertyIds,
  pickStructureProperties,
  slimModelHierarchy,
} from "./modelStructure.js";
import { LocalObjectStore } from "./objects.js";
import { registerModelAssetRoutes } from "./modelAssetRoutes.js";
import { createApiServer } from "./serverOptions.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const hierarchyFixture = {
  schemaVersion: 1,
  root: {
    id: "jt-model:1", name: "coffee-maker.jt", type: "JT 结构模型",
    meshIds: ["jt-instance:a:lod-0:path-0", "jt-instance:b:lod-0:path-1", "jt-instance:c:lod-0:path-2"],
    assemblyPath: [], prototypeId: "p0", sourceObjectId: 1,
    children: [
      { id: "jt-instance:a:lod-0:path-0", name: "机身", type: "装配", meshIds: ["jt-instance:a:lod-0:path-0"], assemblyPath: ["1"], children: [
        { id: "jt-node:10", name: "加热腔", type: "零件", meshIds: [], children: [] },
      ] },
      { id: "jt-instance:b:lod-0:path-1", name: "壶体", type: "零件", meshIds: ["jt-instance:b:lod-0:path-1", "jt-instance:c:lod-0:path-2"], children: [] },
    ],
  },
};

const propertiesFixture = {
  schemaVersion: 1,
  model: { sourceFormat: "JT", meshCount: 3 },
  elements: {
    "jt-instance:a:lod-0:path-0": { elementId: "jt-instance:a:lod-0:path-0", displayProperties: { 名称: "机身", 类型: "装配", 子节点数: "1" } },
    "jt-instance:b:lod-0:path-1": { elementId: "jt-instance:b:lod-0:path-1", displayProperties: { 名称: "壶体", 类型: "零件", 三角面数: "12" } },
    "jt-instance:c:lod-0:path-2": { elementId: "jt-instance:c:lod-0:path-2", displayProperties: { 名称: "把手", 类型: 42, 布尔: true } },
    "jt-node:10": { elementId: "jt-node:10", displayProperties: {} },
  },
};

describe("slimModelHierarchy", () => {
  it("drops large arrays and keeps display counts", () => {
    const result = slimModelHierarchy(hierarchyFixture, { sourceFormat: "jt", sourceName: "coffee-maker.jt" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ schemaVersion: 1, sourceFormat: "jt", sourceName: "coffee-maker.jt", nodeCount: 4, truncated: false });
    expect(JSON.stringify(result.value)).not.toContain("assemblyPath");
    expect(JSON.stringify(result.value)).not.toContain("prototypeId");
    expect(JSON.stringify(result.value)).not.toContain("sourceObjectId");
    expect(result.value.root).toMatchObject({ meshCount: 3, childCount: 2 });
    expect(result.value.root.meshSampleIds).toHaveLength(3);
    expect(result.value.root.children[0]).toMatchObject({ id: "jt-instance:a:lod-0:path-0", name: "机身", meshCount: 1, childCount: 1 });
    expect(result.value.root.children[1]).toMatchObject({ meshCount: 2 });
    expect(result.value.root.children[0]!.children[0]!.meshSampleIds).toBeUndefined();
  });

  it("flags truncation instead of silently hiding deep subtrees", () => {
    const node = (id: string): Record<string, unknown> => ({ id, name: id, meshIds: [], children: [] });
    const wide = { root: { ...node("root"), children: Array.from({ length: MODEL_STRUCTURE_NODE_LIMIT + 5 }, (_, index) => node(`n${index}`)) } };
    const result = slimModelHierarchy(wide, { sourceFormat: "jt", sourceName: "wide.jt" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.truncated).toBe(true);
    expect(result.value.nodeCount).toBe(MODEL_STRUCTURE_NODE_LIMIT);
  });

  it("rejects payloads without a parsable root", () => {
    expect(slimModelHierarchy({}, { sourceFormat: "jt", sourceName: "a.jt" })).toMatchObject({ ok: false });
    expect(slimModelHierarchy({ root: { name: "no-id" } }, { sourceFormat: "jt", sourceName: "a.jt" })).toMatchObject({ ok: false, message: expect.stringContaining("root") });
  });
});

describe("pickStructureProperties", () => {
  it("selects whitelisted entries and reports missing ids explicitly", () => {
    const result = pickStructureProperties(propertiesFixture, ["jt-instance:a:lod-0:path-0", "jt-node:10", "absent-id"]);
    expect(result.missing).toEqual(["absent-id"]);
    expect(result.elements["jt-instance:a:lod-0:path-0"]!.displayProperties).toEqual({ 名称: "机身", 类型: "装配", 子节点数: "1" });
    expect(result.elements["jt-node:10"]!.displayProperties).toEqual({});
    expect(result.elements["absent-id"]).toBeUndefined();
  });

  it("coerces finite numbers and booleans, ignoring exotic values", () => {
    const result = pickStructureProperties(propertiesFixture, ["jt-instance:c:lod-0:path-2"]);
    expect(result.elements["jt-instance:c:lod-0:path-2"]!.displayProperties).toEqual({ 名称: "把手", 类型: "42", 布尔: "是" });
  });

  it("returns only missing ids for malformed payloads", () => {
    const result = pickStructureProperties(null, ["a", "b"]);
    expect(result).toEqual({ schemaVersion: 1, elements: {}, missing: ["a", "b"] });
  });
});

describe("assetObjectKey", () => {
  it("maps model-owned asset URLs to object keys", () => {
    expect(assetObjectKey("p1", "m1", "/assets/projects/p1/models/m1/output/hierarchy.json")).toBe("projects/p1/models/m1/output/hierarchy.json");
  });
  it("rejects foreign models, traversal and query strings", () => {
    expect(() => assetObjectKey("p1", "m1", "/assets/projects/p1/models/other/output/hierarchy.json")).toThrow("不属于该模型");
    expect(() => assetObjectKey("p1", "m1", "/assets/projects/p1/models/m1/../m2/output/hierarchy.json")).toThrow("无效");
    expect(() => assetObjectKey("p1", "m1", "/assets/projects/p1/models/m1/output/hierarchy.json?v=2")).toThrow("查询参数");
  });
});

describe("parseStructurePropertyIds", () => {
  it("trims and filters ids, rejecting empty and oversized batches", () => {
    expect(parseStructurePropertyIds(" a , b ,")).toEqual({ ok: true, ids: ["a", "b"] });
    expect(parseStructurePropertyIds(undefined).ok).toBe(false);
    expect(parseStructurePropertyIds("   ").ok).toBe(false);
    expect(parseStructurePropertyIds(Array.from({ length: 17 }, (_, index) => `n${index}`).join(",")).ok).toBe(false);
  });
});

describe("model structure routes", () => {
  it("serves a slimmed hierarchy and per-id properties for a waiting_converter sidecar", async () => {
    const { app, modelId } = await harness();
    const structure = await app.inject({ method: "GET", url: `/api/projects/default/models/${modelId}/structure` });
    expect(structure.statusCode).toBe(200);
    const payload = structure.json();
    expect(payload).toMatchObject({ schemaVersion: 1, sourceFormat: "jt", nodeCount: 4, truncated: false });
    expect(payload.root.children).toHaveLength(2);
    expect(JSON.stringify(payload)).not.toContain("assemblyPath");

    const properties = await app.inject({ method: "GET", url: `/api/projects/default/models/${modelId}/structure/properties?ids=${encodeURIComponent("jt-instance:a:lod-0:path-0,jt-node:10,missing")}` });
    expect(properties.statusCode).toBe(200);
    expect(properties.json()).toMatchObject({ schemaVersion: 1, missing: ["missing"] });
    expect(properties.json().elements["jt-instance:a:lod-0:path-0"].displayProperties.名称).toBe("机身");
    await app.close();
  });

  it("explains the missing sidecar per conversion status instead of a bare 404", async () => {
    const { app, store } = await harness();
    const now = new Date().toISOString();
    const queued: ModelRecord = {
      ...baseModel("m-queued", now),
      status: "queued",
      message: "等待转换",
    };
    await store.addModel("default", queued);
    const noSidecar = await app.inject({ method: "GET", url: "/api/projects/default/models/m-queued/structure" });
    expect(noSidecar.statusCode).toBe(409);
    expect(noSidecar.json().message).toContain("转换中");

    await store.updateModel("default", "m-queued", { status: "failed", message: "解析崩溃" });
    const failed = await app.inject({ method: "GET", url: "/api/projects/default/models/m-queued/structure" });
    expect(failed.statusCode).toBe(409);
    expect(failed.json().message).toContain("解析崩溃");
    await app.close();
  });

  it("rejects invalid sidecars, foreign asset urls and bad id batches", async () => {
    const { app, dataDir, objects, modelId } = await harness();
    await writeFile(path.join(dataDir, "projects/default/models", modelId, "output", "hierarchy.json"), "{broken", "utf8");
    await objects.putFile(`projects/default/models/${modelId}/output/hierarchy.json`, path.join(dataDir, "projects/default/models", modelId, "output", "hierarchy.json"));
    const broken = await app.inject({ method: "GET", url: `/api/projects/default/models/${modelId}/structure` });
    expect(broken.statusCode).toBe(422);
    expect(broken.json().message).toContain("有效 JSON");

    const foreign = await harness();
    await foreign.store.updateModel("default", foreign.modelId, {
      manifest: {
        schemaVersion: 1, modelId: foreign.modelId, sourceName: "x.jt", sourceFormat: "jt",
        hierarchyUrl: "/assets/projects/default/models/other-model/output/hierarchy.json",
        propertiesUrl: "/assets/projects/default/models/other-model/output/properties.json",
        createdAt: new Date().toISOString(),
      },
    });
    const stolen = await foreign.app.inject({ method: "GET", url: `/api/projects/default/models/${foreign.modelId}/structure` });
    expect(stolen.statusCode).toBe(422);
    expect(stolen.json().message).toContain("不属于该模型");
    await foreign.app.close();

    const noIds = await app.inject({ method: "GET", url: `/api/projects/default/models/${modelId}/structure/properties` });
    expect(noIds.statusCode).toBe(400);
    await app.close();
  });

  it("answers 404 for unknown models", async () => {
    const { app } = await harness();
    expect((await app.inject({ method: "GET", url: "/api/projects/default/models/nope/structure" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/projects/default/models/nope/structure/properties?ids=a" })).statusCode).toBe(404);
    await app.close();
  });
});

async function harness() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bim-structure-"));
  directories.push(dataDir);
  const store = new JsonStore(dataDir);
  await store.init();
  const objects = new LocalObjectStore(dataDir);
  const config = loadConfig();
  config.dataDir = dataDir;
  const queue = new ConversionQueue(store, config, objects);
  const app = createApiServer();
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
  await registerModelAssetRoutes(app, { store, queue, objects, dataDir, config });

  const now = new Date().toISOString();
  const modelId = "m1";
  await store.addModel("default", {
    ...baseModel(modelId, now),
    manifest: {
      schemaVersion: 1,
      modelId,
      sourceName: "coffee-maker.jt",
      sourceFormat: "jt",
      hierarchyUrl: `/assets/projects/default/models/${modelId}/output/hierarchy.json`,
      propertiesUrl: `/assets/projects/default/models/${modelId}/output/properties.json`,
      createdAt: now,
    },
  });
  const outputDir = path.join(dataDir, "projects", "default", "models", modelId, "output");
  await mkdir(outputDir, { recursive: true });
  const hierarchyPath = path.join(outputDir, "hierarchy.json");
  const propertiesPath = path.join(outputDir, "properties.json");
  await writeFile(hierarchyPath, JSON.stringify(hierarchyFixture), "utf8");
  await writeFile(propertiesPath, JSON.stringify(propertiesFixture), "utf8");
  await objects.putFile(`projects/default/models/${modelId}/output/hierarchy.json`, hierarchyPath);
  await objects.putFile(`projects/default/models/${modelId}/output/properties.json`, propertiesPath);
  return { app, store, objects, dataDir, modelId };
}

function baseModel(modelId: string, now: string): ModelRecord {
  return {
    id: modelId,
    projectId: "default",
    name: "coffee-maker.jt",
    format: "jt",
    size: 128,
    status: "waiting_converter",
    progress: 40,
    message: "JT 9.5 结构已读取；未发现可发布的 LOD0 三角网格",
    sourceUrl: `/assets/projects/default/models/${modelId}/source/coffee-maker.jt`,
    createdAt: now,
    updatedAt: now,
  };
}
