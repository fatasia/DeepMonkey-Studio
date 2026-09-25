import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseXtTextDocument, XtGenericSegmentError, type XtGenericDocument } from "./index.js";

/**
 * 全语料回归矩阵：遍历 data/external-assets 下的 X_T 样本，输出解析成功数、
 * 实体族命中与失败原因分布，落盘 test-output/xt-generic-parser-regression-20260925.json。
 * 样本不入库（data/ 已被 git 忽略）；目录缺失时跳过，保持无样本环境可运行。
 */
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const samplesRoot = join(repoRoot, "data/external-assets/industrial-format-plan/samples/downloaded/x_t");
const reportPath = join(repoRoot, "test-output/xt-generic-parser-regression-20260925.json");

interface SampleRecord {
  file: string;
  bytes: number;
  schema?: string;
  encoding: string;
  circles: number;
  planes: number;
  cylinders: number;
  cones: number;
  spheres: number;
  tori: number;
  transforms: number;
  censusTop: Record<string, number>;
  error?: string;
}

describe("X_T generic parser corpus regression", () => {
  it.runIf(existsSync(samplesRoot))("sweeps every sample and publishes the regression report", async () => {
    const files = listXtFiles(samplesRoot).sort();
    expect(files.length).toBeGreaterThan(100);

    const records: SampleRecord[] = [];
    const failures = new Map<string, number>();
    let parseOk = 0;
    for (const file of files) {
      const relative = relativeSamplePath(file);
      try {
        const source = await readFile(file);
        const document = parseXtTextDocument(source);
        parseOk += 1;
        records.push(toRecord(relative, source.byteLength, document));
      } catch (error) {
        const reason = error instanceof XtGenericSegmentError ? error.message : "unexpected-error";
        failures.set(reason, (failures.get(reason) ?? 0) + 1);
        records.push({
          file: relative, bytes: -1, encoding: "invalid",
          circles: 0, planes: 0, cylinders: 0, cones: 0, spheres: 0, tori: 0, transforms: 0,
          censusTop: {}, error: reason,
        });
      }
    }

    const familyTotals = {
      circles: sum(records, (item) => item.circles),
      planes: sum(records, (item) => item.planes),
      cylinders: sum(records, (item) => item.cylinders),
      cones: sum(records, (item) => item.cones),
      spheres: sum(records, (item) => item.spheres),
      tori: sum(records, (item) => item.tori),
      transforms: sum(records, (item) => item.transforms),
    };
    const encodingCounts = countBy(records, (item) => item.encoding);
    const schemaCounts = countBy(records, (item) => item.schema ?? "unknown");
    const formatTextFiles = records.filter((item) => item.encoding === "format-text").length;

    const report = {
      generatedAt: new Date().toISOString(),
      sampleRoot: "data/external-assets/industrial-format-plan/samples/downloaded/x_t",
      totalSamples: files.length,
      parsedSamples: parseOk,
      parseFailureCount: files.length - parseOk,
      failureReasons: Object.fromEntries(failures),
      encodingCounts,
      schemaCounts,
      familyHitTotals: familyTotals,
      familyHitRateByFile: {
        circles: rate(records, (item) => item.circles > 0),
        planes: rate(records, (item) => item.planes > 0),
        tori: rate(records, (item) => item.tori > 0),
        cylinders: rate(records, (item) => item.cylinders > 0),
        cones: rate(records, (item) => item.cones > 0),
        spheres: rate(records, (item) => item.spheres > 0),
        transforms: rate(records, (item) => item.transforms > 0),
      },
      samples: records,
    };

    mkdirSync(join(repoRoot, "test-output"), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

    // 语料事实断言：两种编码都要被如实分类；已验证布局的族命中必须稳定。
    expect(formatTextFiles + (encodingCounts["legacy-baseline"] ?? 0)).toBe(files.length);
    expect(familyTotals.circles).toBeGreaterThan(1000);
    expect(familyTotals.tori).toBeGreaterThan(10);
    expect(familyTotals.planes).toBeGreaterThan(10);
  }, 300_000);
});

function listXtFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".x_t")) files.push(path);
    }
  };
  walk(root);
  return files;
}

function relativeSamplePath(file: string): string {
  return file.slice(samplesRoot.length + 1).split(/[\\/]/).join("/");
}

function toRecord(file: string, bytes: number, document: XtGenericDocument): SampleRecord {
  return {
    file,
    bytes,
    ...(document.header.identificationSchema ? { schema: document.header.identificationSchema } : {}),
    encoding: document.header.encodingClass,
    circles: document.circles.length,
    planes: document.planes.length,
    cylinders: document.cylinders.length,
    cones: document.cones.length,
    spheres: document.spheres.length,
    tori: document.tori.length,
    transforms: document.transforms.length,
    censusTop: Object.fromEntries(Object.entries(document.census).sort((a, b) => b[1] - a[1]).slice(0, 12)),
  };
}

function sum(records: SampleRecord[], pick: (item: SampleRecord) => number): number {
  return records.reduce((total, item) => total + pick(item), 0);
}

function countBy(records: SampleRecord[], key: (item: SampleRecord) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of records) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

function rate(records: SampleRecord[], hit: (item: SampleRecord) => boolean): number {
  return Number((records.filter(hit).length / Math.max(1, records.length)).toFixed(4));
}
