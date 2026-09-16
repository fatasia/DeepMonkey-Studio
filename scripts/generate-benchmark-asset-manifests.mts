/** DE26/A02:从本机真实资产生成基准清单 v1(哈希/体量实测,不估算)。
 *  用法:pnpm exec tsx scripts/generate-benchmark-asset-manifests.mts */
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBenchmarkAssetManifest, type BenchmarkAssetManifest } from "../packages/deep-engine/src/benchmarkAssetManifest.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const outputDir = path.join(root, "packages/deep-engine/fixtures/benchmark-assets");

async function sha256File(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

/** 三份真实项目;路径为本机实测,资产字节不入 git。 */
const candidates = [
  { id: "asset.bim.snowdon-towers-arch", name: "Snowdon Towers Sample Architectural", domain: "bim" as const,
    primaryLoadClass: "heterogeneous-bim" as const,
    relative: "test-model/Snowdon Towers Sample Architectural.rvt",
    origin: "Autodesk Revit sample content (local install)",
    units: "feet", formatVersion: "unknown",
    license: { redistributable: false, evidence: "Autodesk sample content; local benchmark use only, not redistributable" },
    tasks: [{ kind: "appearance" as const, fixtureId: "fixture.appearance.orbit-360" }] },
  { id: "asset.bim.golden-nugget-arch", name: "BIM Projekt Golden Nugget - Architektur und Ingenieurbau", domain: "bim" as const,
    primaryLoadClass: "heterogeneous-bim" as const,
    relative: "D:/Soft/Revit/RVT2019/Revit 2019/Samples/BIM_Projekt_Golden_Nugget-Architektur_und_Ingenieurbau.rvt",
    origin: "Autodesk Revit 2019 sample content (local install)",
    units: "millimeters", formatVersion: "2019",
    license: { redistributable: false, evidence: "Autodesk sample content; local benchmark use only, not redistributable" },
    tasks: [{ kind: "appearance" as const, fixtureId: "fixture.appearance.facade-sweep" }, { kind: "dashboard" as const, fixtureId: "fixture.dashboard.component-count" }] },
  { id: "asset.bim.rme-advanced-mep", name: "rme_advanced_sample_project (MEP)", domain: "bim" as const,
    primaryLoadClass: "heterogeneous-bim" as const,
    relative: "D:/Soft/Revit/RVT2019/Revit 2019/Samples/rme_advanced_sample_project.rvt",
    origin: "Autodesk Revit 2019 sample content (local install)",
    units: "feet", formatVersion: "2019",
    license: { redistributable: false, evidence: "Autodesk sample content; local benchmark use only, not redistributable" },
    tasks: [{ kind: "appearance" as const, fixtureId: "fixture.appearance.mep-isolation" }, { kind: "animation" as const, fixtureId: "fixture.animation.system-flow" }] },
];

const manifests: BenchmarkAssetManifest[] = [];
for (const candidate of candidates) {
  const absolute = path.resolve(root, candidate.relative);
  const size = (await stat(absolute)).size;
  if (size <= 0) throw new Error(`Asset is empty: ${absolute}`);
  const sha256 = await sha256File(absolute);
  manifests.push(createBenchmarkAssetManifest({
    schema: "deep-engine.benchmark-asset-manifest",
    schemaVersion: 1,
    id: candidate.id, name: candidate.name, domain: candidate.domain, primaryLoadClass: candidate.primaryLoadClass,
    source: { path: absolute, bytes: size, sha256, format: "rvt", formatVersion: candidate.formatVersion },
    units: candidate.units,
    license: candidate.license,
    // RVT 解析归工业格式 PLAN;转换前三角面/材质如实缺省,不由本脚本估算。
    tasks: candidate.tasks,
    cacheConditions: ["cold", "warm"],
  }));
  console.log(`✓ ${candidate.id} bytes=${size} sha256=${sha256.slice(0, 12)}…`);
}

await mkdir(outputDir, { recursive: true });
const output = path.join(outputDir, "manifests-v1.json");
await writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(), manifests }, null, 2));
console.log(`\nWrote ${manifests.length} manifests → ${path.relative(root, output)}`);
await readdir(outputDir).catch(() => []);
