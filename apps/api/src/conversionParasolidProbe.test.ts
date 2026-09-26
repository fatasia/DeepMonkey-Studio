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
import { LocalObjectStore } from "./objects.js";
import { createApiServer } from "./serverOptions.js";
import { minimalXtRevolvedSubsetFixture } from "./fixtures/minimalXtRevolvedSubset.js";

/**
 * Parasolid schema-aware 三档接线回归（2026-09-26 定案）：
 * - 配置 PARASOLID_SCHEMA_CATALOG（此处经 mock CLI 注入）后，子集+通用都拒绝的 X_T
 *   走第三档：waiting_converter + inspection.genericParse.schemaAware 权威证据；
 * - 未配置探针/catalog 时 X_T 行为逐字节不变（无 schemaAware 键、消息不变）；
 * - X_B 在探针存在且工业转换器未配置时升级为"结构可检、几何待离散化"；
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

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
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
        ...(!options.withoutCatalog ? { schemaCatalog: "unused-by-mock-catalog.txt" } : {}),
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
