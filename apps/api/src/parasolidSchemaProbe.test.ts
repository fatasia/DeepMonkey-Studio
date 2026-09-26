import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createParasolidProbeRunner, defaultParasolidProbeCommand } from "./parasolidSchemaProbe.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const mockScript = fileURLToPath(new URL("./fixtures/psSchemaProbeMock.mjs", import.meta.url));
const mockProbe = { command: process.execPath, args: [mockScript] };

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("parasolid schema probe runner", () => {
  it("parses the CLI --json contract through an injectable command", async () => {
    const run = createParasolidProbeRunner(mockProbe);
    const report = await run({ filePath: "sample.x_t", brep: true });
    expect(report.tool).toBe("ps-schema-probe");
    expect(report.mode).toBe("schema-aware");
    expect(report.sourceFormat).toBe("x_t");
    expect(report.census?.recordCount).toBe(2998);
    expect(report.brep?.faces).toBe(153);
    expect(report.brep?.topologyValid).toBe(true);
  });

  it("runs census mode (no --brep) for binary payloads", async () => {
    const run = createParasolidProbeRunner(mockProbe);
    const report = await run({ filePath: "sample.x_b" });
    expect(report.mode).toBe("census");
    expect(report.sourceFormat).toBe("x_b");
    expect(report.brep).toBeUndefined();
    expect(report.note).toContain("census");
  });

  it("surfaces non-zero exits with stderr as the failure reason", async () => {
    const run = createParasolidProbeRunner({ ...mockProbe });
    process.env.PROBE_MOCK_FAILURE = "1";
    try {
      await expect(run({ filePath: "sample.x_t" })).rejects.toThrow("injected probe failure");
    } finally {
      delete process.env.PROBE_MOCK_FAILURE;
    }
  });

  it("rejects stdout that is not valid JSON", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "probe-invalid-json-"));
    directories.push(directory);
    const script = path.join(directory, "bad.mjs");
    await writeFile(script, 'process.stdout.write("not json");');
    const run = createParasolidProbeRunner({ command: process.execPath, args: [script] });
    await expect(run({ filePath: "sample.x_t" })).rejects.toThrow("不是合法 JSON");
  });

  it("enforces the configurable stdout byte cap", async () => {
    const run = createParasolidProbeRunner({ ...mockProbe, maxOutputBytes: 128 });
    await expect(run({ filePath: "sample.x_t", brep: true })).rejects.toThrow("超过字节上限");
  });
});

describe("ps-schema-probe bundled CLI (built by scripts/build-parasolid-probe.mjs)", () => {
  const bundledCommand = defaultParasolidProbeCommand();

  it.runIf(bundledCommand)("resolves the bundled probe executable", () => {
    expect(existsSync(bundledCommand!)).toBe(true);
  });

  const cadConvertSample = path.join(repoRoot, "data/external-assets/format-fixtures/x_t/cadconvert-small.x_t");
  const hingeSample = path.join(
    repoRoot,
    "data/external-assets/industrial-format-plan/samples/downloaded/x_t/asmith-hinges",
    "A  Hinges (鉸鏈)/Butt Hinges平面鉸鍊/AS-2059.x_t",
  );
  // gmsh 2.11 contrib 内的 sch_13006 catalog：仅本地验证用（运行链不依赖、不入仓）。
  const localCatalog = path.join(
    repoRoot,
    "data/external-assets/format-research/gmsh-2.11.0-source/contrib/Parasolid/interface_parasolid/schema/sch_13006.sch_txt",
  );

  it.runIf(bundledCommand && existsSync(cadConvertSample))(
    "reads a real V24.1 sample in census mode with honest trim boundaries",
    async () => {
      const run = createParasolidProbeRunner({ command: bundledCommand! });
      const report = await run({ filePath: cadConvertSample });
      expect(report.sourceFormat).toBe("x_t");
      expect(report.mode).toBe("census");
      expect(report.schemaKey).toBe("SCH_2401231_20000_13006");
      expect(report.census).toBeUndefined();
      expect(report.note).toContain("trim 拓扑未解码");
    },
  );

  it.runIf(bundledCommand && existsSync(hingeSample) && existsSync(localCatalog))(
    "decodes authoritative trim topology for a real SolidWorks sample with a schema catalog",
    async () => {
      const run = createParasolidProbeRunner({ command: bundledCommand!, schemaCatalog: localCatalog });
      const report = await run({ filePath: hingeSample, brep: true });
      expect(report.mode).toBe("schema-aware");
      expect(report.schemaKey).toBe("SCH_2100263_20000_13006");
      expect(report.catalog).toMatchObject({ schemaId: "13006" });
      expect(report.census?.recordCount).toBeGreaterThan(0);
      expect(report.brep?.faces).toBeGreaterThan(0);
      expect(report.brep?.topologyValid).toBe(true);
    },
  );

  it.runIf(bundledCommand && existsSync(hingeSample) && existsSync(localCatalog))(
    "triangulates real AS-2059 B-Rep faces with honest losses (R1 MVP)",
    async () => {
      const run = createParasolidProbeRunner({ command: bundledCommand!, schemaCatalog: localCatalog });
      const report = await run({ filePath: hingeSample, brep: true, geometry: true });
      const geometry = report.geometry;
      expect(geometry).toBeDefined();
      // 真实铰链样本:绝大多数面可发布(平面/柱/锥/环),blended_edge 如实跳过。
      expect(geometry!.stats.facesTotal).toBe(report.brep?.faces);
      expect(geometry!.stats.facesPublished).toBeGreaterThan(100);
      expect(geometry!.stats.triangles).toBeGreaterThan(0);
      expect(geometry!.stats.vertices).toBeGreaterThan(0);
      expect(geometry!.budgetExceeded).toBe(false);
      const publishedKinds = new Set(geometry!.faces.map((face) => face.surfaceKind));
      for (const kind of publishedKinds) {
        expect(["plane", "cylinder", "cone", "sphere", "torus"]).toContain(kind);
      }
      for (const face of geometry!.faces) {
        expect(face.positions.length).toBeGreaterThan(0);
        expect(face.positions.length % 3).toBe(0);
        expect(face.indices.length % 3).toBe(0);
        expect(face.indices.length / 3).toBeGreaterThan(0);
        for (const index of face.indices) expect(index).toBeLessThan(face.positions.length / 3);
      }
      // 不支持族必须出现在诚实损失里。
      expect(geometry!.losses).toContain("surface.blended_edge:not-triangulated");
      expect(geometry!.skipped.length).toBe(
        geometry!.stats.facesTotal - geometry!.stats.facesPublished,
      );
    },
    120_000,
  );

  it.runIf(bundledCommand && existsSync(hingeSample) && existsSync(localCatalog))(
    "stops publishing when the face budget is exhausted",
    async () => {
      const run = createParasolidProbeRunner({
        command: bundledCommand!,
        args: ["--max-faces", "20"],
        schemaCatalog: localCatalog,
      });
      const report = await run({ filePath: hingeSample, brep: true, geometry: true });
      const geometry = report.geometry!;
      expect(geometry.stats.facesPublished).toBeLessThanOrEqual(20);
      expect(geometry.budgetExceeded).toBe(true);
      expect(geometry.losses).toContain("geometry.budget:faces-exhausted");
      expect(geometry.skipped.length).toBe(
        geometry.stats.facesTotal - geometry.stats.facesPublished,
      );
    },
    120_000,
  );
});
