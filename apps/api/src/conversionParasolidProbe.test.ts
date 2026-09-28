import multipart from "@fastify/multipart";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRecord } from "@bim-studio/contracts";
import { loadConfig } from "./config.js";
import { ConversionQueue } from "./conversion.js";
import { JsonStore } from "./jsonStore.js";
import { registerModelAssetRoutes } from "./modelAssetRoutes.js";
import { defaultParasolidProbeCommand } from "./parasolidSchemaProbe.js";
import { LocalObjectStore } from "./objects.js";
import { createApiServer } from "./serverOptions.js";
import { minimalXtRevolvedSubsetFixture } from "./fixtures/minimalXtRevolvedSubset.js";

/**
 * Parasolid schema-aware 三档接线回归（2026-09-26 定案,R1 扩展）：
 * - 配置 PARASOLID_SCHEMA_CATALOG（此处经 mock CLI 注入）后，子集+通用都拒绝的 X_T
 *   走第三档：探针发布 ≥1 个面 → ready(MVP 三角化 GLB)；无 geometry 字段（旧 CLI）
 *   或 0 个面 → waiting_converter + inspection.genericParse.schemaAware 权威证据；
 * - 未配置探针/catalog 时 X_T 行为逐字节不变（无 schemaAware 键、消息不变）；
 * - X_B 在探针存在且工业转换器未配置时：有 geometry → ready；否则"结构可检、几何待离散化"；
 * - X_B 在工业转换器已配置时保持阻断（不因探针存在而改变优先级）。
 */
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const mockScript = fileURLToPath(new URL("./fixtures/psSchemaProbeMock.mjs", import.meta.url));
const mockProbe = { command: process.execPath, args: [mockScript] };

const samplesRoot = path.join(
  repoRoot,
  "data/external-assets/industrial-format-plan/samples/downloaded/x_t/asmith-hinges",
);
const legacySample = existsSync(samplesRoot)
  ? path.join(samplesRoot, "A  Hinges (鉸鏈)/Butt Hinges平面鉸鍊/A-2621/A-2621.x_t")
  : undefined;
// AS-2059(SCH_2100263_20000_13006)真实几何三角化回归在 parasolidSchemaProbe.test.ts
// (CLI 层);conversion 队列层走 legacy-baseline A-2621(通用档 0 网格才进第三档)。
// gmsh contrib 内的 schema catalog:仅本地验证用(运行链不依赖、不入仓)。
const catalogRoot = path.join(
  repoRoot,
  "data/external-assets/format-research/gmsh-2.11.0-source/contrib/Parasolid/interface_parasolid/schema",
);
const localCatalog = existsSync(path.join(catalogRoot, "sch_13006.sch_txt"))
  ? path.join(catalogRoot, "sch_13006.sch_txt")
  : undefined;
// A-2621 是 SCH_901000_9008(legacy-baseline):通用档 0 网格 → 走第三档。
const legacyCatalog = existsSync(path.join(catalogRoot, "sch_9008.sch_txt"))
  ? path.join(catalogRoot, "sch_9008.sch_txt")
  : undefined;
const bundledCommand = defaultParasolidProbeCommand();
const researchSolid = path.join(repoRoot, "test-output/x-t-builtin-solid-20260928/two-boxes.x_t");
const brokenResearchSolid = path.join(repoRoot, "test-output/x-t-builtin-solid-20260928/broken-loop.x_t");
const unmatchedKey = path.join(repoRoot, "data/external-assets/format-fixtures/x_t/parasolid-kit/values.x_t");

const directories: string[] = [];

afterEach(async () => {
  delete process.env.PROBE_MOCK_GEOMETRY;
  delete process.env.PROBE_MOCK_GEOMETRY_FACES;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("X_T builtin exact-key research inspection through upload queue", () => {
  it.runIf(bundledCommand && existsSync(researchSolid))(
    "uploads a two-BODY compact X_T, retains inspect-only manifest and no GLB despite triangulation",
    async () => {
      const { app, store, dataDir, objects, queue } = await createServer({ probe: { command: bundledCommand!, args: [] }, withoutCatalog: true });
      try {
        const source = await readFile(researchSolid);
        const { model } = await uploadAndSettle(app, store, "research-two-boxes.x_t", source, "waiting_converter");
        expect(model.conversionTaskId).toBeDefined();
        expect(model.message).toContain("研发解析");
        expect(model.manifest?.geometryUrl).toBeUndefined();
        const output = attemptOutput(dataDir, model);
        const inspection = JSON.parse(await readFile(path.join(output, "inspection.json"), "utf8"));
        expect(inspection.genericParse.schemaAware).toMatchObject({
          schemaKey: "SCH_3000000_30000", catalog: { schemaId: "builtin:onshape-sch30000-r3" },
          brep: { bodies: 2, faces: 12, topologyValid: true },
          geometryPublication: "waiting-independent-real-evidence",
        });
        expect(inspection.genericParse.schemaAware.geometry.stats).toMatchObject({ facesPublished: 12, triangles: 24 });
        const manifest = JSON.parse(await readFile(path.join(path.dirname(output), "manifest.json"), "utf8"));
        expect(manifest.geometryUrl).toBeUndefined();
        expect(manifest.inspectionUrl).toContain("/output/inspection.json");
        expect(await objects.stat(`projects/default/models/${model.id}/attempts/${model.conversionTaskId}/output/inspection.json`)).toBe(true);
        await expect(readFile(path.join(output, "geometry.glb"))).rejects.toMatchObject({ code: "ENOENT" });
        const structure = await app.inject({ method: "GET", url: `/api/projects/default/models/${model.id}/structure` });
        expect(structure.statusCode).toBe(409);
        expect(structure.json().message).toContain("尚未为该文件发布可视化产物");
        expect(queue.tasks.get("default", model.conversionTaskId!)?.quality?.tier).toBe("inspect");
      } finally {
        await app.close();
      }
    },
  );

  it.runIf(bundledCommand && existsSync(brokenResearchSolid))(
    "rejects broken topology without publishing builtin B-Rep evidence or GLB",
    async () => {
      const { app, store, dataDir } = await createServer({ probe: { command: bundledCommand!, args: [] }, withoutCatalog: true });
      try {
        const { model } = await uploadAndSettle(app, store, "broken-loop.x_t", await readFile(brokenResearchSolid), "failed");
        const output = attemptOutput(dataDir, model);
        await expect(readFile(path.join(output, "geometry.glb"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(model.manifest?.geometryUrl).toBeUndefined();
      } finally {
        await app.close();
      }
    },
  );

  it.runIf(bundledCommand && existsSync(unmatchedKey))(
    "unknown/empty-body compact key cannot publish geometry or claim builtin evidence",
    async () => {
      const { app, store, dataDir } = await createServer({ probe: { command: bundledCommand!, args: [] }, withoutCatalog: true });
      try {
        const { model } = await uploadAndSettle(app, store, "values.x_t", await readFile(unmatchedKey), "failed");
        const output = attemptOutput(dataDir, model);
        await expect(readFile(path.join(output, "geometry.glb"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(model.manifest?.geometryUrl).toBeUndefined();
      } finally {
        await app.close();
      }
    },
  );
});

describe("X_T schema-aware geometry publication (R1 MVP)", () => {
  it.runIf(legacySample)(
    "publishes a GLB when the probe returns triangulated faces",
    async () => {
      process.env.PROBE_MOCK_GEOMETRY = "1";
      const { app, store, dataDir } = await createServer({ probe: mockProbe });
      try {
        const source = await readFile(legacySample!);
        const result = await uploadAndSettle(app, store, "legacy-hinge.x_t", source, "ready");
        expect(result.model.message).toContain("MVP 三角化");
        expect(result.model.message).toContain("如实损失");
        expect(result.model.manifest?.geometryUrl).toBeDefined();
        expect(result.model.manifest?.hierarchyUrl).toBeDefined();
        const outputDir = attemptOutput(dataDir, result.model);
        await expect(readFile(path.join(outputDir, "geometry.glb"))).resolves.toBeInstanceOf(Buffer);
        const inspection = JSON.parse(await readFile(path.join(outputDir, "inspection.json"), "utf8"));
        expect(inspection.geometryParsed).toBe(true);
        expect(inspection.genericParse.schemaAware.geometryPublication).toBe("published:brep-triangulation-mvp");
        const hierarchy = JSON.parse(await readFile(path.join(outputDir, "hierarchy.json"), "utf8"));
        expect(hierarchy.root.children).toHaveLength(2);
      } finally {
        await app.close();
      }
    },
  );

  it.runIf(legacySample)(
    "keeps the waiting semantics when the probe publishes zero faces",
    async () => {
      process.env.PROBE_MOCK_GEOMETRY = "1";
      process.env.PROBE_MOCK_GEOMETRY_FACES = "0";
      const { app, store, dataDir } = await createServer({ probe: mockProbe });
      try {
        const source = await readFile(legacySample!);
        const result = await uploadAndSettle(app, store, "legacy-hinge.x_t", source, "waiting_converter");
        expect(result.model.message).toContain("权威结构已读取");
        expect(result.model.manifest?.geometryUrl).toBeUndefined();
        const outputDir = attemptOutput(dataDir, result.model);
        await expect(readFile(path.join(outputDir, "geometry.glb"))).rejects.toMatchObject({ code: "ENOENT" });
        const inspection = JSON.parse(await readFile(path.join(outputDir, "inspection.json"), "utf8"));
        expect(inspection.genericParse.schemaAware.geometryPublication).toBe("waiting-brep-triangulation-r1");
      } finally {
        await app.close();
      }
    },
  );

  it.runIf(bundledCommand && legacySample && legacyCatalog)(
    "publishes real legacy-baseline hinge geometry end-to-end through the conversion queue",
    async () => {
      const { app, store, dataDir } = await createServer({
        probe: { command: bundledCommand! },
        realCatalog: legacyCatalog,
      });
      try {
        const source = await readFile(legacySample!);
        const result = await uploadAndSettle(app, store, "A-2621.x_t", source, "ready");
        expect(result.model.message).toContain("MVP 三角化");
        expect(result.model.manifest?.geometryUrl).toBeDefined();
        expect(result.model.manifest?.hierarchyUrl).toBeDefined();
        expect(result.model.manifest?.propertiesUrl).toBeDefined();
        // LOD 仅对 ≥8MB 的 GLB 生成(glbOptimizer 阈值),小模型按既有语义省略。
        const outputDir = attemptOutput(dataDir, result.model);
        const glb = await readFile(path.join(outputDir, "geometry.glb"));
        expect(glb.byteLength).toBeGreaterThan(10_000);
        const hierarchy = JSON.parse(await readFile(path.join(outputDir, "hierarchy.json"), "utf8"));
        expect(hierarchy.root.children).toHaveLength(2);
        expect(hierarchy.root.children[0].meshIds.length).toBeGreaterThan(0);
        const inspection = JSON.parse(await readFile(path.join(outputDir, "inspection.json"), "utf8"));
        expect(inspection.genericParse.schemaAware.schemaKey).toBe("SCH_901000_9008");
        expect(inspection.genericParse.schemaAware.geometry.stats.facesPublished).toBeGreaterThan(0);
        expect(inspection.genericParse.schemaAware.geometryPublication).toBe(
          "published:brep-triangulation-mvp",
        );
      } finally {
        await app.close();
      }
    },
    180_000,
  );
});

describe("X_T third schema-aware tier", () => {
  it.runIf(legacySample)(
    "records authoritative schema-aware evidence for a legacy-baseline sample when the catalog is configured",
    async () => {
      const { app, store, dataDir } = await createServer({ probe: mockProbe });
      try {
        const source = await readFile(legacySample!);
        const result = await uploadAndSettle(app, store, "legacy-hinge.x_t", source, "waiting_converter");
        expect(result.model.message).toContain("权威结构已读取");
        expect(result.model.message).toContain("faces=153");
        expect(result.model.message).toContain("R1");
        expect(result.model.manifest?.geometryUrl).toBeUndefined();
        const outputDir = attemptOutput(dataDir, result.model);
        const inspection = JSON.parse(await readFile(path.join(outputDir, "inspection.json"), "utf8"));
        expect(inspection.geometryParsed).toBe(false);
        const evidence = inspection.genericParse.schemaAware;
        expect(evidence.source).toBe("ps-schema-probe");
        expect(evidence.schemaKey).toBe("SCH_2100263_20000_13006");
        expect(evidence.recordCount).toBe(2998);
        expect(evidence.brep.faces).toBe(153);
        expect(evidence.brep.topologyValid).toBe(true);
        expect(evidence.geometryPublication).toBe("waiting-brep-triangulation-r1");
        // 本期刻意不发布几何：三角化（R1）未实现，绝不出现半成品 GLB。
        await expect(readFile(path.join(outputDir, "geometry.glb"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await app.close();
      }
    },
  );

  it.runIf(legacySample)(
    "keeps the legacy-baseline waiting path byte-identical when no catalog is configured",
    async () => {
      const { app, store, dataDir } = await createServer({ probe: mockProbe, withoutCatalog: true });
      try {
        const source = await readFile(legacySample!);
        const result = await uploadAndSettle(app, store, "legacy-hinge.x_t", source, "waiting_converter");
        expect(result.model.message).toContain("通用解析未命中可发布几何");
        expect(result.model.message).not.toContain("schema-aware");
        const outputDir = attemptOutput(dataDir, result.model);
        const inspection = JSON.parse(await readFile(path.join(outputDir, "inspection.json"), "utf8"));
        expect(inspection.geometryParsed).toBe(false);
        // 探针存在但 catalog 未配置：第三档关闭，genericParse 只含既有 census 键。
        expect(Object.keys(inspection.genericParse).sort()).toEqual(["census", "scope"]);
        expect(Object.keys(inspection.genericParse.census ?? {}).length).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    },
  );

  it("falls back to the merged-failure semantics when the probe fails", async () => {
    const { app, store } = await createServer({ probe: mockProbe, failure: true });
    try {
      // 合法头部 + 超限填充体：通用解析直接抛错（与既有回归一致）；探针被注入失败
      // → 完整回落到"合并两个解析器失败原因"的既有语义，不出现 schema-aware 证据。
      const oversized = Buffer.concat([
        Buffer.from(minimalXtRevolvedSubsetFixture()),
        Buffer.alloc(17 * 1024 * 1024, 0x41),
      ]);
      const result = await uploadAndSettle(app, store, "oversized.x_t", oversized, "waiting_converter");
      expect(result.model.message).not.toContain("权威结构已读取");
      expect(result.model.message).toContain("头部已读取");
      expect(result.model.message).toContain("；通用解析：");
    } finally {
      delete process.env.PROBE_MOCK_FAILURE;
      await app.close();
    }
  });
});

describe("X_B structure evidence tier", () => {
  it("publishes X_B geometry when the probe returns triangulated faces", async () => {
    process.env.PROBE_MOCK_GEOMETRY = "1";
    const { app, store, dataDir } = await createServer({ probe: mockProbe });
    try {
      const result = await uploadAndSettle(app, store, "part.x_b", Buffer.from("PARASOLID neutral binary fixture"), "ready");
      expect(result.model.message).toContain("X_B 权威 B-Rep 几何已发布");
      expect(result.model.manifest?.geometryUrl).toBeDefined();
      const outputDir = attemptOutput(dataDir, result.model);
      await expect(readFile(path.join(outputDir, "geometry.glb"))).resolves.toBeInstanceOf(Buffer);
      const inspection = JSON.parse(await readFile(path.join(outputDir, "inspection.json"), "utf8"));
      expect(inspection.geometryParsed).toBe(true);
      expect(inspection.schemaAware.geometryPublication).toBe("published:brep-triangulation-mvp");
    } finally {
      await app.close();
    }
  });

  it("upgrades X_B from a black box to structure-inspectable while keeping waiting_converter (census)", async () => {
    const { app, store, dataDir } = await createServer({ probe: mockProbe, withoutCatalog: true });
    try {
      const result = await uploadAndSettle(app, store, "part.x_b", Buffer.from("PARASOLID neutral binary fixture"), "waiting_converter");
      expect(result.model.message).toContain("X_B");
      expect(result.model.message).toContain("ps-schema-probe census");
      expect(result.model.message).toContain("R1");
      const outputDir = attemptOutput(dataDir, result.model);
      const inspection = JSON.parse(await readFile(path.join(outputDir, "inspection.json"), "utf8"));
      expect(inspection.recognizedFormat).toBe("parasolid-x_b");
      expect(inspection.geometryParsed).toBe(false);
      expect(inspection.schemaAware.source).toBe("ps-schema-probe");
      expect(inspection.schemaAware.schemaKey).toBe("SCH_3000000_30000");
      expect(inspection.topology.bodies.status).toBe("not-decoded");
      expect(inspection.geometry.reason).toContain("R1");
      expect(result.model.manifest?.inspectionUrl).toBeDefined();
      await expect(readFile(path.join(outputDir, "geometry.glb"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await app.close();
    }
  });

  it("decodes authoritative topology for X_B when the schema catalog is configured", async () => {
    const { app, store, dataDir } = await createServer({ probe: mockProbe });
    try {
      const result = await uploadAndSettle(app, store, "part.x_b", Buffer.from("PARASOLID neutral binary fixture"), "waiting_converter");
      expect(result.model.message).toContain("权威结构已读取");
      expect(result.model.message).toContain("faces=153");
      const outputDir = attemptOutput(dataDir, result.model);
      const inspection = JSON.parse(await readFile(path.join(outputDir, "inspection.json"), "utf8"));
      expect(inspection.schemaAware.mode).toBe("schema-aware");
      expect(inspection.schemaAware.brep.faces).toBe(153);
      expect(inspection.topology.bodies).toMatchObject({ status: "decoded", count: 2 });
      expect(inspection.geometry.status).toBe("not-decoded");
      await expect(readFile(path.join(outputDir, "geometry.glb"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await app.close();
    }
  });

  it("falls back to the blocked X_B semantics when the probe execution fails", async () => {
    const { app, store } = await createServer({ probe: mockProbe, failure: true });
    try {
      const result = await uploadAndSettle(app, store, "part.x_b", Buffer.from("PARASOLID neutral binary fixture"), "waiting_converter");
      expect(result.model.message).toContain("内置离线解析 profile 尚未就绪");
      expect(result.model.message).not.toContain("ps-schema-probe");
      expect(result.model.manifest).toBeUndefined();
      expect(result.model.manifestUrl).toBeUndefined();
    } finally {
      delete process.env.PROBE_MOCK_FAILURE;
      await app.close();
    }
  });

  it("keeps the blocked X_B semantics when the industrial converter command is configured", async () => {
    const { app, store } = await createServer({
      probe: mockProbe,
      industrialCadCommand: { command: process.execPath, args: ["-e", "process.exit(1)"], cwd: process.cwd() },
    });
    try {
      const result = await uploadAndSettle(app, store, "part.x_b", Buffer.from("transport fixture"), "waiting_converter");
      expect(result.model.message).toContain("内置离线解析 profile 尚未就绪");
      expect(result.model.message).not.toContain("ps-schema-probe");
      expect(result.model.manifest).toBeUndefined();
      expect(result.model.manifestUrl).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("keeps the blocked X_B semantics when no probe is built", async () => {
    const { app, store } = await createServer({});
    try {
      const result = await uploadAndSettle(app, store, "part.x_b", Buffer.from("PARASOLID neutral binary fixture"), "waiting_converter");
      expect(result.model.message).toContain("内置离线解析 profile 尚未就绪");
      expect(result.model.manifest).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

async function createServer(options: {
  probe?: { command: string; args: string[] };
  withoutCatalog?: boolean;
  failure?: boolean;
  realCatalog?: string;
  industrialCadCommand?: { command: string; args: string[]; cwd: string };
}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bim-parasolid-probe-"));
  directories.push(dataDir);
  const store = new JsonStore(dataDir);
  await store.init();
  const objects = new LocalObjectStore(dataDir);
  const config = loadConfig();
  config.dataDir = dataDir;
  config.industrialCad = options.industrialCadCommand
    ? { ...options.industrialCadCommand, cwd: options.industrialCadCommand.cwd ?? process.cwd() }
    : { args: [], cwd: process.cwd() };
  // 显式接管探针配置：避免本机构建的 dist 产物影响基线行为；未提供时强制关闭。
  config.parasolidProbe = options.probe
    ? {
        command: options.probe.command,
        args: options.probe.args,
        // 真实 CLI 测试注入真实 catalog;mock 测试保持占位路径(mock 忽略该参数)。
        schemaCatalog: options.realCatalog ?? (options.withoutCatalog ? undefined : "unused-by-mock-catalog.txt"),
      }
    : undefined;
  if (options.failure) process.env.PROBE_MOCK_FAILURE = "1";
  const queue = new ConversionQueue(store, config, objects);
  const app = createApiServer();
  await app.register(multipart, { limits: { fileSize: 32 * 1024 * 1024, files: 1 } });
  await registerModelAssetRoutes(app, { store, queue, objects, dataDir, config });
  return { app, store, queue, objects, dataDir };
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
): Promise<{ model: ModelRecord; message: string }> {
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
  return { model, message: model.message ?? "" };
}
