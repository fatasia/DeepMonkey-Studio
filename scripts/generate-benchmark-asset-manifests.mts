/** DE26/A02:从本机真实资产生成基准清单 v1(哈希/体量实测,不估算)。
 *  用法:pnpm exec tsx scripts/generate-benchmark-asset-manifests.mts */
import { createHash } from "node:crypto";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBenchmarkAssetManifest, validateBenchmarkAssetManifest, type BenchmarkAssetManifest } from "../packages/deep-engine/src/benchmarkAssetManifest.ts";
import { createBenchmarkTrajectory, type BenchmarkTrajectory } from "../packages/deep-engine/src/benchmarkAssetTrajectory.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const outputDir = path.join(root, "packages/deep-engine/fixtures/benchmark-assets");

async function sha256File(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

interface GlbStats {
  triangles: number;
  meshes: number;
  materials: number;
  textures: number;
  bounds: { min: [number, number, number]; max: [number, number, number] } | undefined;
}

/** GLB JSON chunk 精确统计:三角形=三角网 primitive 的索引/POSITION 数,包围盒=POSITION accessor min/max。
 *  全部为容器内实测值,不做任何估算;解析失败直接抛错而不是回填近似值。 */
function measureGlb(buffer: Buffer): GlbStats {
  if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error("not a GLB container (magic mismatch)");
  const jsonLength = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.toString("utf8", 20, 20 + jsonLength)) as {
    meshes?: { primitives?: { mode?: number; indices?: number; attributes?: { POSITION?: number } } }[];
    accessors?: { count: number; min?: number[]; max?: number[] }[];
    materials?: unknown[];
    textures?: unknown[];
  };
  let triangles = 0;
  let positionAccessors = 0;
  let boundedAccessors = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const mode = primitive.mode ?? 4;
      if (mode !== 4 || primitive.attributes?.POSITION === undefined) continue;
      // 三角计数用索引 accessor;bounds 必须回到 POSITION accessor(索引 accessor 是标量,不带 min/max)。
      const indexAccessor = primitive.indices !== undefined ? json.accessors?.[primitive.indices] : undefined;
      const positionAccessor = json.accessors?.[primitive.attributes.POSITION];
      if (primitive.indices !== undefined && !indexAccessor) throw new Error("GLB index accessor missing; refusing to estimate stats");
      if (!positionAccessor) throw new Error("GLB POSITION accessor missing; refusing to estimate stats");
      triangles += (indexAccessor?.count ?? positionAccessor.count) / 3;
      positionAccessors += 1;
      if (positionAccessor.min?.length === 3 && positionAccessor.max?.length === 3) {
        boundedAccessors += 1;
        for (const axis of [0, 1, 2] as const) {
          min[axis] = Math.min(min[axis]!, positionAccessor.min[axis]!);
          max[axis] = Math.max(max[axis]!, positionAccessor.max[axis]!);
        }
      }
    }
  }
  return {
    triangles,
    meshes: json.meshes?.length ?? 0,
    materials: json.materials?.length ?? 0,
    textures: json.textures?.length ?? 0,
    // 任一 POSITION accessor 缺 min/max 时宁可如实缺省,也不交出不完整包围盒(轨迹归一化依赖它)。
    bounds: positionAccessors > 0 && boundedAccessors === positionAccessors
      ? { min: [...min] as [number, number, number], max: [...max] as [number, number, number] }
      : undefined,
  };
}

type Candidate = {
  id: string;
  name: string;
  domain: "factory" | "bim" | "campus";
  primaryLoadClass: BenchmarkAssetManifest["primaryLoadClass"];
  relative: string;
  origin: string;
  units: string;
  format: "rvt" | "glb";
  formatVersion: string;
  license: BenchmarkAssetManifest["license"];
  tasks: BenchmarkAssetManifest["tasks"];
};

/** 真实项目语料(用户 2026-09-17 指定:用 Download 目录)。
 *  路径为本机实测,资产字节不入 git;不可再分发资产只记录哈希与本机路径。 */
const candidates: Candidate[] = [
  // "(1)" 与原文件字节级相同(同 sha256),去重保留一份。
  { id: "asset.bim.bimface-demo-1", name: "BIMFACE 示例模型", domain: "bim",
    primaryLoadClass: "heterogeneous-bim",
    relative: "D:/Download/BIMFACE示例模型.rvt",
    origin: "BIMFACE public demo model (local download)",
    units: "millimeters", format: "rvt", formatVersion: "unknown",
    license: { redistributable: false, evidence: "BIMFACE public demo; local benchmark use only, not redistributable" },
    tasks: [{ kind: "appearance", fixtureId: "fixture.appearance.orbit-360" },
      { kind: "dashboard", fixtureId: "fixture.dashboard.component-count" }] },
  { id: "asset.bim.snowdon-towers-arch", name: "Snowdon Towers Sample Architectural", domain: "bim",
    primaryLoadClass: "heterogeneous-bim",
    relative: "test-model/Snowdon Towers Sample Architectural.rvt",
    origin: "Autodesk Revit sample content (local install)",
    units: "feet", format: "rvt", formatVersion: "unknown",
    license: { redistributable: false, evidence: "Autodesk sample content; local benchmark use only, not redistributable" },
    tasks: [{ kind: "appearance", fixtureId: "fixture.appearance.orbit-360" }] },
  { id: "asset.bim.baked-scene", name: "BIM 烘焙测试场景(glTF 导出)", domain: "bim",
    primaryLoadClass: "heterogeneous-bim",
    relative: "D:/Download/bim烘培测试源文件.glb",
    origin: "User-collected local download; THREE.GLTFExporter r184 export; provenance undocumented",
    units: "meters (glTF nominal)", format: "glb", formatVersion: "2.0",
    license: { redistributable: false, evidence: "User-collected download; local benchmark use only, provenance undocumented, not redistributable" },
    tasks: [{ kind: "appearance", fixtureId: "fixture.appearance.orbit-360" },
      { kind: "dashboard", fixtureId: "fixture.dashboard.component-count" }] },
  { id: "asset.factory.preheater-far-origin", name: "预热机(远原点工业设备)", domain: "factory",
    primaryLoadClass: "far-origin-campus",
    relative: "D:/Download/预热机.glb-optimized.glb",
    origin: "User-collected local download; glTF-Transform v4.1.3 optimized derivative of 预热机.glb; provenance undocumented",
    units: "meters (glTF nominal)", format: "glb", formatVersion: "2.0",
    license: { redistributable: false, evidence: "User-collected download; local benchmark use only, provenance undocumented, not redistributable" },
    tasks: [{ kind: "appearance", fixtureId: "fixture.appearance.orbit-360" }] },
  { id: "asset.factory.battery-stack-exploded", name: "叠片电池爆炸装配(带动画)", domain: "factory",
    primaryLoadClass: "dynamic-workcell",
    relative: "D:/Download/叠片-电池爆炸.optimized.glb",
    origin: "User-collected local download; glTF-Transform v4.4.2 optimized derivative of 叠片-电池爆炸.glb; provenance undocumented",
    units: "meters (glTF nominal)", format: "glb", formatVersion: "2.0",
    license: { redistributable: false, evidence: "User-collected download; local benchmark use only, provenance undocumented, not redistributable" },
    tasks: [{ kind: "appearance", fixtureId: "fixture.appearance.orbit-360" },
      { kind: "interaction", fixtureId: "fixture.factory.select-clip" },
      { kind: "animation", fixtureId: "fixture.factory.animation-replay" }] },
  { id: "asset.factory.battery-stack-instances", name: "叠片电池实例化装配场景", domain: "factory",
    primaryLoadClass: "factory-instances",
    relative: "D:/Download/叠片-电池爆炸.optimized.glb",
    origin: "Same measured source as asset.factory.battery-stack-exploded; scenario-level instance stress role",
    units: "meters (glTF nominal)", format: "glb", formatVersion: "2.0",
    license: { redistributable: false, evidence: "User-collected local source; local benchmark use only, not redistributable" },
    tasks: [{ kind: "animation", fixtureId: "fixture.factory.animation-replay" }] },
  { id: "asset.dashboard.mixed-bim-scene", name: "混合 BIM 看板场景", domain: "bim",
    primaryLoadClass: "mixed-dashboard",
    relative: "D:/Download/bim烘培测试源文件.glb",
    origin: "Same measured source as asset.bim.baked-scene; dashboard composition scenario role",
    units: "meters (glTF nominal)", format: "glb", formatVersion: "2.0",
    license: { redistributable: false, evidence: "User-collected local source; local benchmark use only, not redistributable" },
    tasks: [{ kind: "dashboard", fixtureId: "fixture.dashboard.component-count" }] },
  { id: "asset.showcase.appearance-scene", name: "外观材质展示场景", domain: "bim",
    primaryLoadClass: "appearance-showcase",
    relative: "D:/Download/bim烘培测试源文件.glb",
    origin: "Same measured source as asset.bim.baked-scene; appearance showcase scenario role",
    units: "meters (glTF nominal)", format: "glb", formatVersion: "2.0",
    license: { redistributable: false, evidence: "User-collected local source; local benchmark use only, not redistributable" },
    tasks: [{ kind: "appearance", fixtureId: "fixture.appearance.orbit-360" }] },
];

// 轨迹夹具先过合同校验;appearance/interaction 的 fixtureId 必须能对上已冻结轨迹,悬空引用拒绝生成。
const trajectoryFile = path.join(outputDir, "trajectories-v1.json");
const frozenTrajectories = JSON.parse(await readFile(trajectoryFile, "utf8")) as { trajectories: BenchmarkTrajectory[] };
const trajectoryIds = new Set(frozenTrajectories.trajectories.map(item => {
  createBenchmarkTrajectory(item);
  return item.id;
}));

const manifests: BenchmarkAssetManifest[] = [];
for (const candidate of candidates) {
  const absolute = path.resolve(root, candidate.relative);
  const size = (await stat(absolute)).size;
  if (size <= 0) throw new Error(`Asset is empty: ${absolute}`);
  const sha256 = await sha256File(absolute);
  for (const task of candidate.tasks) {
    if (task.kind === "dashboard") continue; // 看板夹具是统计任务,不挂相机轨迹
    if (!trajectoryIds.has(task.fixtureId)) {
      throw new Error(`Dangling fixture reference ${task.fixtureId} on ${candidate.id}; freeze the trajectory first`);
    }
  }
  // RVT 解析归工业格式 PLAN:转换前几何统计如实缺省;GLB 由容器直接精确统计。
  const stats = candidate.format === "glb"
    ? { ...measureGlb(await readFile(absolute)), measuredBy: "glb-json-chunk-parse (scripts/generate-benchmark-asset-manifests.mts)" }
    : undefined;
  const manifest = createBenchmarkAssetManifest({
    schema: "deep-engine.benchmark-asset-manifest",
    schemaVersion: 1,
    id: candidate.id, name: candidate.name, domain: candidate.domain, primaryLoadClass: candidate.primaryLoadClass,
    source: { path: absolute, bytes: size, sha256, format: candidate.format, formatVersion: candidate.formatVersion },
    units: candidate.units,
    license: candidate.license,
    stats,
    tasks: candidate.tasks,
    cacheConditions: ["cold", "warm"],
  });
  const issues = validateBenchmarkAssetManifest(manifest);
  if (issues.length) throw new Error(`manifest ${candidate.id} failed validation: ${JSON.stringify(issues)}`);
  manifests.push(manifest);
  console.log(`✓ ${candidate.id} bytes=${size} triangles=${stats?.triangles ?? "n/a"} textures=${stats?.textures ?? "n/a"} sha256=${sha256.slice(0, 12)}…`);
}

await mkdir(outputDir, { recursive: true });
const output = path.join(outputDir, "manifests-v1.json");
await writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(), manifests }, null, 2));
console.log(`\nWrote ${manifests.length} manifests → ${path.relative(root, output)}`);
