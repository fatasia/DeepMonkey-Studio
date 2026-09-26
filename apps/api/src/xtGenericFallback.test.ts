import multipart from "@fastify/multipart";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ModelRecord } from "@bim-studio/contracts";
import { loadConfig } from "./config.js";
import { ConversionQueue } from "./conversion.js";
import { JsonStore } from "./jsonStore.js";
import { registerModelAssetRoutes } from "./modelAssetRoutes.js";
import { LocalObjectStore } from "./objects.js";
import { createApiServer } from "./serverOptions.js";
import { auditGlbGeometry } from "./converterOutputAudit.js";
import { minimalXtRevolvedSubsetFixture } from "./fixtures/minimalXtRevolvedSubset.js";
import { sha256File } from "./conversionQualityDraft.js";
import { buildXtGenericReadyQuality as buildGenericDraft } from "./xtGenericQualityDraft.js";

/**
 * X_T 双档生产导入回归:
 * - V24.1 旋转体子集继续走受控路径,输出逐字节不变;
 * - 非 V24.1 的 format-text 样本走通用降级档,ready(visual-complete) 且 losses 如实;
 * - legacy-baseline(0 可发布面片)保持 waiting_converter,绝不 ready 空几何;
 * - 质量草稿必须通过合同校验并被任务持久化。
 */
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const samplesRoot = path.join(
  repoRoot,
  "data/external-assets/industrial-format-plan/samples/downloaded/x_t/asmith-hinges",
);
const formatTextSample = existsSync(samplesRoot)
  ? path.join(samplesRoot, "A  Hinges (鉸鏈)/Lift-Off外露可拆鉸鍊/AS(T)-2211/AS(T)-2211.x_t")
  : undefined;
const legacySample = existsSync(samplesRoot)
  ? path.join(samplesRoot, "A  Hinges (鉸鏈)/Butt Hinges平面鉸鍊/A-2621/A-2621.x_t")
  : undefined;

const directories: string[] = [];
const uploadedModels: Array<{ store: JsonStore; model: ModelRecord; dataDir: string; app: Awaited<ReturnType<typeof createServer>>["app"] }> = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("X_T generic fallback production path", () => {
  it.runIf(existsSync(path.join(repoRoot, "data/external-assets/format-fixtures/x_t/cadconvert-small.x_t")))(
    "keeps the signed V24.1 revolved subset byte-identical through the original path",
    async () => {
      const { app, store, queue, dataDir } = await createServer();
      try {
        const fixtureSource = await renderFixtureToTemp();
        const result = await uploadAndSettle(app, store, "rotor.x_t", fixtureSource, "ready");
        // 既有受控路径的精确输出:10 个面、4224 个三角面,消息与产物结构不变。
        expect(result.model.message).toContain("X_T 旋转体转换完成：10 个面，4,224 个三角面");
        const outputDir = attemptOutput(dataDir, result.model);
        await expect(auditGlbGeometry(path.join(outputDir, "geometry.glb"))).resolves.toMatchObject({
          meshCount: 10,
          primitiveCount: 10,
          triangleCount: 4224,
        });
        const geometryHash = await sha256File(path.join(outputDir, "geometry.glb"));
        const sidecarHashes = await Promise.all(["hierarchy.json", "properties.json"].map(
          (name) => sha256File(path.join(outputDir, name)),
        ));
        expect(geometryHash).toBe("79b59609e21751da11d270de4e98bba7a4f368f67a4c4da535f6007d49bbef8b");
        expect(sidecarHashes).toEqual([
          "46e691333a2536d9644e733a825ab0dbd862dbd3d56ee1650e55d8690cb864df",
          "3415eee59bce81b1170d9a3f3743c39b120a95d4702656be233480a46eeba7d6",
        ]);
        // 质量档保持原受控 profile,不混入 generic 证据。
        const task = queue.tasks.get("default", result.model.conversionTaskId!);
        expect(task?.quality).toMatchObject({ profileId: "builtin-x-t-revolved-subset", tier: "visual-complete" });
      } finally {
        await app.close();
      }
    },
  );

  it.runIf(formatTextSample)(
    "falls a non-V24.1 format-text sample through to the generic tier with honest losses",
    async () => {
      const { app, store, queue, dataDir } = await createServer();
      try {
        const source = await readFile(formatTextSample!);
        const result = await uploadAndSettle(app, store, "generic-hinge.x_t", source, "ready");
        // 通用降级档 ready:装配节点与真实 losses 必须落盘。
        expect(result.model.message).toContain("通用解析完成");
        const outputDir = attemptOutput(dataDir, result.model);
        const hierarchy = JSON.parse(await readFile(path.join(outputDir, "hierarchy.json"), "utf8"));
        expect(hierarchy.partial).toBe(true);
        expect(hierarchy.root.children[0].name).toBe("PART 1");
        expect(hierarchy.root.children[0].meshIds.length).toBeGreaterThan(0);
        const properties = JSON.parse(await readFile(path.join(outputDir, "properties.json"), "utf8"));
        expect(properties.model.losses).toContain("brep.trim");
        expect(properties.model.losses).toContain("entity.names");
        expect(properties.model.losses).toContain("entity.colors");
        expect(properties.model.encodingClass).toBe("format-text");
        await expect(auditGlbGeometry(path.join(outputDir, "geometry.glb"))).resolves.toMatchObject({
          triangleCount: expect.any(Number),
        });
        const evidence = await auditGlbGeometry(path.join(outputDir, "geometry.glb"));
        expect(evidence.triangleCount).toBeGreaterThan(0);
        // 质量报告持久化:tier/losses/metrics 来自通用档草稿,带实体族命中计数。
        const task = queue.tasks.get("default", result.model.conversionTaskId!);
        expect(task?.quality).toMatchObject({
          profileId: "builtin-x-t-generic-visual-complete",
          tier: "visual-complete",
          losses: expect.arrayContaining(["brep.trim", "entity.names", "entity.colors", "assembly.instance-linkage"]),
        });
        expect(task?.quality?.metrics?.engine).toBe("builtin-xt-generic");
        expect(task?.quality?.metrics?.triangleCount).toBe(evidence.triangleCount);
        expect(Object.keys(task?.quality?.metrics?.entityCounts ?? {}))
          .toEqual(expect.arrayContaining(["circles", "spheres", "publishedMeshes"]));
        expect(task?.quality?.checks.map((check) => check.dimension)).toEqual(
          ["geometry", "structure", "identity", "coordinates", "dependencies"]);
      } finally {
        await app.close();
      }
    },
  );

  it.runIf(legacySample)(
    "keeps a legacy-baseline sample waiting and records the generic-parse census",
    async () => {
      const { app, store, queue, dataDir } = await createServer();
      try {
        const source = await readFile(legacySample!);
        const result = await uploadAndSettle(app, store, "legacy-hinge.x_t", source, "waiting_converter");
        expect(result.model.message).toContain("通用解析未命中可发布几何");
        expect(result.model.manifest?.geometryUrl).toBeUndefined();
        const outputDir = attemptOutput(dataDir, result.model);
        const inspection = JSON.parse(await readFile(path.join(outputDir, "inspection.json"), "utf8"));
        expect(inspection.geometryParsed).toBe(false);
        expect(inspection.genericParse.scope).toContain("record-anchor-census");
        expect(Object.keys(inspection.genericParse.census ?? {}).length).toBeGreaterThan(0);
        expect(inspection.geometry.reason).toContain("SCH_2401231_20000_1300");
        // legacy-baseline 编码如实记录在 genericParse 视角内(来源:通用解析的编码分类)。
        expect(result.model.message).not.toContain("旋转体转换完成");
        await expect(readFile(path.join(outputDir, "geometry.glb"))).rejects.toMatchObject({ code: "ENOENT" });
        // waiting 任务带 inspect 档质量草稿(执行器回填),不是 ready 凭证。
        const task = queue.tasks.get("default", result.model.conversionTaskId!);
        expect(task?.quality?.tier).toBe("inspect");
      } finally {
        await app.close();
      }
    },
  );

  it("merges both parser failure reasons when the two parsers reject differently", async () => {
    const { app, store } = await createServer();
    try {
      // 结构头合法(结构探测通过)但体积超过子集与通用档的上限:两个解析器在
      // 不同阶段分别拒绝,合并后的消息必须同时呈现两份原因。
      const oversized = Buffer.concat([
        Buffer.from(minimalXtRevolvedSubsetFixture()),
        Buffer.alloc(17 * 1024 * 1024, 0x41),
      ]);
      const result = await uploadAndSettle(app, store, "oversized.x_t", oversized, "waiting_converter");
      expect(result.model.message).toContain("头部已读取");
      expect(result.model.message).toContain("；通用解析：");
      expect(result.model.message).toContain("字节之间");
    } finally {
      await app.close();
    }
  });

  it("reports an invalid structure without inventing a generic failure reason", async () => {
    const { app, store } = await createServer();
    try {
      const result = await uploadAndSettle(app, store, "broken.x_t", Buffer.from("not a parasolid transport at all"), "failed");
      expect(result.model.message).toContain("X_T 文件结构无效");
      // 两个解析器对同一缺陷给出同一原因时去重,不重复拼接。
      expect(result.model.message).not.toContain("；通用解析：");
    } finally {
      await app.close();
    }
  });
});

describe("X_T generic quality draft contract", () => {
  it("passes the machine-readable contract with family entity counts", async () => {
    const { mkdtemp: mk, writeFile: write } = await import("node:fs/promises");
    const dir = await mk(path.join(tmpdir(), "xt-generic-quality-"));
    directories.push(dir);
    for (const name of ["geometry.glb", "hierarchy.json", "properties.json", "inspection.json"]) {
      await write(path.join(dir, name), `evidence:${name}`);
    }
    const draft = await buildGenericDraft({
      outputDir: dir,
      partial: true,
      losses: ["surface.plane:untrimmed-extent-unknown", "brep.trim", "entity.names", "entity.colors", "assembly.instance-linkage"],
      approximations: ["geometry.tessellation:angular-64-segments"],
      meshCount: 13,
      triangleCount: 37376,
      vertexCount: 37376,
      familyCounts: { circles: 9, planes: 0, cylinders: 0, cones: 0, spheres: 9, tori: 0, transforms: 3 },
      encodingClass: "format-text",
    });
    const { assertConversionQualityReport } = await import("@bim-studio/contracts");
    expect(() => assertConversionQualityReport({ ...draft, sourceHash: "a".repeat(64) })).not.toThrow();
    expect(draft.metrics?.entityCounts).toMatchObject({ spheres: 9, publishedMeshes: 13 });
  });

  it("keeps both draft builders importable: generic from its module, revolved from the shared module", async () => {
    const { buildXtRevolvedReadyQuality } = await import("./conversionQualityDraft.js");
    expect(buildGenericDraft).toBeTypeOf("function");
    expect(buildXtRevolvedReadyQuality).toBeTypeOf("function");
  });
});

async function createServer() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bim-xt-generic-fallback-"));
  directories.push(dataDir);
  const store = new JsonStore(dataDir);
  await store.init();
  const objects = new LocalObjectStore(dataDir);
  const config = loadConfig();
  config.dataDir = dataDir;
  config.industrialCad = { args: [], cwd: process.cwd() };
  const queue = new ConversionQueue(store, config, objects);
  const app = createApiServer();
  await app.register(multipart, { limits: { fileSize: 32 * 1024 * 1024, files: 1 } });
  await registerModelAssetRoutes(app, { store, queue, objects, dataDir, config });
  return { app, store, queue, objects, dataDir };
}

async function renderFixtureToTemp(): Promise<Buffer> {
  return Buffer.from(minimalXtRevolvedSubsetFixture());
}

function attemptOutput(dataDir: string, model: ModelRecord): string {
  return path.join(dataDir, "projects", model.projectId, "models", model.id, "attempts", model.conversionTaskId!, "output");
}

async function uploadAndSettle(
  app: ReturnType<typeof createApiServer>,
  store: JsonStore,
  fileName: string,
  content: Buffer | Uint8Array,
  finalStatus: "ready" | "waiting_converter" | "failed",
): Promise<{ model: ModelRecord }> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(content)], { type: "application/octet-stream" }), fileName);
  const encoded = new Response(form);
  const response = await app.inject({
    method: "POST",
    url: "/api/projects/default/models",
    headers: { "content-type": encoded.headers.get("content-type")! },
    payload: Buffer.from(await encoded.arrayBuffer()),
  });
  expect(response.statusCode).toBe(202);
  const uploaded = response.json() as ModelRecord;
  await vi.waitFor(() => {
    expect(store.getProject("default")?.models.find((item) => item.id === uploaded.id)?.status).toBe(finalStatus);
  }, { timeout: 30_000, interval: 50 });
  const model = store.getProject("default")!.models.find((item) => item.id === uploaded.id)!;
  return { model };
}
