import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { ConverterPluginManifest } from "@bim-studio/contracts";
import {
  MODEL_FORMAT_CAPABILITY_CATALOG,
  assertConversionQualityReport,
  findModelFormatCapability,
  validateModelFormatCapability,
  type ConversionQualityReport
} from "@bim-studio/contracts";
import { ConversionTaskService } from "./conversionTasks.js";
import { buildJtLod0ReadyQuality, buildXtRevolvedReadyQuality } from "./conversionQualityDraft.js";
const sha = "a".repeat(64);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const manifest: ConverterPluginManifest = { contractVersion: 1, id: "test.quality", name: "Quality", version: "1", execution: "server-worker",
  inputFormats: ["jt"], outputs: [{ kind: "log", format: "json", required: false }], capabilities: [], configurationSchema: {},
  limits: { timeoutMs: 1000, maxInputBytes: 100, maxOutputBytes: 100, maxMemoryMb: 100, maxCpuPercent: 100 } };
describe("quality gate at model publication", () => {
  it.each(["inspect", "preview"] as const)("blocks %s from activating ready", async tier => {
    const service = new ConversionTaskService([{ manifest, execute: async context => {
      context.reportSourceBundle({ schemaVersion: 1, sourceName: "a.jt", sourceFormat: "jt", contentHash: sha, bundledPath: "a.jt", licenseReference: "local-only" });
      context.reportQuality({ schemaVersion: 1, sourceHash: sha, profileId: "limited-jt-v1", tier,
        checks: [{ dimension: "geometry", passed: false, reason: "missing-face" }], losses: ["missing-face"], approximations: [] });
      context.stageModelUpdate({ status: "ready" });
    } }]);
    const task = service.submit({ projectId: "project-1", modelId: "model-1", pluginId: manifest.id,
      input: { fileName: "a.jt", format: "jt", size: 1, objectKey: "projects/project-1/a.jt", sha256: sha } });
    await vi.waitFor(() => expect(service.get("project-1", task.id)?.status).toBe("failed"));
    expect(service.get("project-1", task.id)).toMatchObject({ artifacts: [], message: expect.stringContaining("不能激活 ready"),
      sourceBundle: { contentHash: sha }, quality: { tier, sourceHash: sha, losses: ["missing-face"] } });
  });
  it("rejects client hashes that do not match the executor source identity", async () => {
    const service = new ConversionTaskService([{ manifest, execute: async context => context.reportSourceBundle({
      schemaVersion: 1, sourceName: "a.jt", sourceFormat: "jt", contentHash: "b".repeat(64), bundledPath: "a.jt", licenseReference: "local-only",
    }) }]);
    const task = service.submit({ projectId: "project-1", pluginId: manifest.id,
      input: { fileName: "a.jt", format: "jt", size: 1, objectKey: "projects/project-1/a.jt", sha256: sha } });
    await vi.waitFor(() => expect(service.get("project-1", task.id)?.status).toBe("failed"));
    expect(service.get("project-1", task.id)?.sourceBundle).toBeUndefined();
  });
  it("accepts visual-complete with machine-readable declared losses and persists the report on a ready model", async () => {
    const service = new ConversionTaskService([{ manifest, execute: async context => {
      context.reportSourceBundle({ schemaVersion: 1, sourceName: "a.jt", sourceFormat: "jt", contentHash: sha, bundledPath: "a.jt", licenseReference: "local-only" });
      context.reportQuality({ schemaVersion: 1, sourceHash: sha, profileId: "builtin-jt-lod0-visual-complete", tier: "visual-complete",
        checks: ["geometry", "structure", "identity", "coordinates", "dependencies"].map(dimension => ({
          dimension: dimension as ConversionQualityReport["checks"][number]["dimension"], passed: true, evidenceSha256: sha })),
        losses: ["geometry.uv", "vertex.colors"], approximations: ["geometry.normals:computed-vertex-normals"],
        metrics: { engine: "builtin-jt-worker", workerVersion: "1.0.0", meshCount: 2, triangleCount: 96, instanceCount: 3,
          entityCounts: { tocSegments: 4, assemblyNodes: 6 } } });
      context.stageModelUpdate({ status: "ready" });
    } }]);
    const task = service.submit({ projectId: "project-1", modelId: "model-1", pluginId: manifest.id,
      input: { fileName: "a.jt", format: "jt", size: 1, objectKey: "projects/project-1/a.jt", sha256: sha } });
    await vi.waitFor(() => expect(service.get("project-1", task.id)?.status).toBe("succeeded"));
    const result = service.get("project-1", task.id);
    expect(result?.quality).toMatchObject({
      tier: "visual-complete", profileId: "builtin-jt-lod0-visual-complete",
      losses: ["geometry.uv", "vertex.colors"],
      metrics: { engine: "builtin-jt-worker", triangleCount: 96, instanceCount: 3 },
    });
    expect(result?.quality?.checks).toHaveLength(5);
  });
  it("rejects visual-complete whose losses are narrative instead of machine-readable tags", async () => {
    const service = new ConversionTaskService([{ manifest, execute: async context => {
      context.reportSourceBundle({ schemaVersion: 1, sourceName: "a.jt", sourceFormat: "jt", contentHash: sha, bundledPath: "a.jt", licenseReference: "local-only" });
      context.reportQuality({ schemaVersion: 1, sourceHash: sha, profileId: "builtin-jt-lod0-visual-complete", tier: "visual-complete",
        checks: ["geometry", "structure", "identity", "coordinates", "dependencies"].map(dimension => ({
          dimension: dimension as ConversionQualityReport["checks"][number]["dimension"], passed: true, evidenceSha256: sha })),
        losses: ["缺少一些面"], approximations: [] });
      context.stageModelUpdate({ status: "ready" });
    } }]);
    const task = service.submit({ projectId: "project-1", modelId: "model-1", pluginId: manifest.id,
      input: { fileName: "a.jt", format: "jt", size: 1, objectKey: "projects/project-1/a.jt", sha256: sha } });
    await vi.waitFor(() => expect(service.get("project-1", task.id)?.status).toBe("failed"));
    expect(service.get("project-1", task.id)?.message).toContain("机器可读标签");
  });
});

async function withOutputFiles(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "xt-quality-"));
  for (const name of ["geometry.glb", "hierarchy.json", "properties.json", "inspection.json"]) {
    await writeFile(path.join(dir, name), `fake:${name}`);
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("builtin conversion quality drafts and catalog runtime facts", () => {
  it("publishes an honest X_T subset draft that passes the contract", async () => {
    const { dir, cleanup } = await withOutputFiles();
    try {
      const draft = await buildXtRevolvedReadyQuality({
        outputDir: dir, meshCount: 10, triangleCount: 1280, bodyCount: 1, faceCount: 10,
      });
      const report: ConversionQualityReport = { ...draft, sourceHash: sha };
      expect(() => assertConversionQualityReport(report)).not.toThrow();
      expect(report.tier).toBe("visual-complete");
      expect(report.profileId).toBe("builtin-x-t-revolved-subset");
      expect(report.checks.map((check) => check.dimension)).toEqual(
        ["geometry", "structure", "identity", "coordinates", "dependencies"]);
      expect(report.losses).toEqual(expect.arrayContaining(["brep.trim", "entity.names", "entity.colors"]));
      expect(report.metrics).toMatchObject({ engine: "builtin-xt-revolved-subset", meshCount: 10, triangleCount: 1280 });
      expect(report.metrics?.entityCounts).toEqual({ bodies: 1, faces: 10 });
    } finally {
      await cleanup();
    }
  });

  it("publishes an honest JT LOD0 draft without claiming losses that do not exist", async () => {
    const { dir, cleanup } = await withOutputFiles();
    try {
      // 真实样本未携带 UV/Color binding:decodedAttributes 缺省时草稿必须保留两项损失。
      const draft = await buildJtLod0ReadyQuality({
        outputDir: dir, meshCount: 3, triangleCount: 456, instanceCount: 7, tocEntryCount: 12, assemblyNodeCount: 34,
      });
      const report: ConversionQualityReport = { ...draft, sourceHash: sha };
      expect(() => assertConversionQualityReport(report)).not.toThrow();
      expect(report.profileId).toBe("builtin-jt-lod0-visual-complete");
      // 法线在转换时计算；缺的只有 UV 与顶点色，不得虚构 normals 损失。
      expect(report.losses).toEqual(["geometry.uv", "vertex.colors"]);
      expect(report.approximations).not.toContain("geometry.uv:quantized-reconstruction");
      expect(report.metrics?.instanceCount).toBe(7);
      expect(report.metrics?.entityCounts).toEqual({ tocSegments: 12, assemblyNodes: 34 });
    } finally {
      await cleanup();
    }
  });

  it("narrows JT LOD0 losses when the converter decoded UV and vertex colors", async () => {
    const { dir, cleanup } = await withOutputFiles();
    try {
      const draft = await buildJtLod0ReadyQuality({
        outputDir: dir, meshCount: 3, triangleCount: 456, instanceCount: 7, tocEntryCount: 12, assemblyNodeCount: 34,
        decodedAttributes: { uvs: true, colors: true },
      });
      const report: ConversionQualityReport = { ...draft, sourceHash: sha };
      expect(() => assertConversionQualityReport(report)).not.toThrow();
      // 解码成功:对应损失移除,改为量化重建近似项;仍然不存在 normals 损失。
      expect(report.losses).toEqual([]);
      expect(report.approximations).toEqual(expect.arrayContaining([
        "geometry.normals:computed-vertex-normals",
        "geometry.uv:quantized-reconstruction",
        "vertex.colors:quantized-reconstruction",
      ]));
    } finally {
      await cleanup();
    }
  });

  it("keeps the JT loss when only UV decoded but vertex colors remain missing", async () => {
    const { dir, cleanup } = await withOutputFiles();
    try {
      const draft = await buildJtLod0ReadyQuality({
        outputDir: dir, meshCount: 1, triangleCount: 12, instanceCount: 1, tocEntryCount: 9, assemblyNodeCount: 11,
        decodedAttributes: { uvs: true, colors: false },
      });
      expect(draft.losses).toEqual(["vertex.colors"]);
      expect(draft.approximations).toContain("geometry.uv:quantized-reconstruction");
      expect(draft.approximations).not.toContain("vertex.colors:quantized-reconstruction");
    } finally {
      await cleanup();
    }
  });

  it("keeps catalog runtime facts machine-readable, evidenced and short of production readiness", () => {
    for (const extension of ["jt", "x_t"]) {
      const capability = findModelFormatCapability(extension)!;
      expect(capability.implementationStatus).toBe("implemented");
      expect(capability.runtimeStatus).toBe("degraded");
      expect(capability.validationStatus).toBe("fixture-validated");
      expect(capability.runtimeFacts?.qualityTier).toBe("visual-complete");
      expect(capability.runtimeFacts?.losses.length).toBeGreaterThan(0);
      // 受控子集不等于生产可用：事实注记不得把判定抬到 production-validated。
      expect(capability.validationStatus === "production-validated").toBe(false);
    }
    expect(findModelFormatCapability("jt")?.runtimeFacts?.losses).toContain("geometry.uv");
    expect(findModelFormatCapability("x_t")?.runtimeFacts?.notes.join("\n")).toContain("generic-parser");
    expect(MODEL_FORMAT_CAPABILITY_CATALOG.flatMap(validateModelFormatCapability)).toEqual([]);
    // 证据必须指向仓内可追溯文件；样本引用片段必须是真实 fixture 名。
    for (const capability of MODEL_FORMAT_CAPABILITY_CATALOG) {
      for (const evidence of capability.validationEvidence) {
        const [file, sample] = evidence.reference.split("#");
        const regressionReport = "test-output/xt-generic-parser-regression-20260925.json";
        if (file !== regressionReport) {
          expect(existsSync(path.join(repoRoot, file!)), evidence.reference).toBe(true);
        }
        if (sample) expect(/^[A-Za-z0-9._-]+$/.test(sample), evidence.reference).toBe(true);
      }
    }
  });
});
