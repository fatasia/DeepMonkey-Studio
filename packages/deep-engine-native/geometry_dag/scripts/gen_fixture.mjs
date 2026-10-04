#!/usr/bin/env node
// 黄金样本生成器(Nanite M2,Rust 对拍用)。
//
// 职责:
//   1. 生成 5 万三角形确定性合成资产(synthetic50k.obj)+ 小型快测资产(quick_sphere.obj)。
//   2. 调用 TS 侧权威实现(packages/deep-engine/dist/geometry 的 buildMeshletDag,与 src 同步
//      的 esbuild 产物,纯相对导入 ESM、零外部依赖)跑出黄金 DAG,导出 JSON fixture:
//      输入网格 + 每层 positions/indices/descriptors/vertexRemap/localTriangleIndices/
//      bounds/sourceTriangles/clusterSourceSpans(base64 原始 LE 字节,逐位无损)+ error
//      (JSON number,f64 round-trip 精确)+ parentsByLevel。
//
// 运行:node scripts/gen_fixture.mjs(须先构建 deep-engine 包产物 dist/geometry)。
// 输出:tests/fixtures/{quick_sphere,synthetic50k}.{obj,golden.json}
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "../tests/fixtures");
// scripts → geometry_dag → deep-engine-native → packages
const DAG_MODULE = path.resolve(HERE, "../../../deep-engine/dist/geometry/meshletDag.js");

if (!existsSync(DAG_MODULE)) {
  console.error(`[gen_fixture] 缺少 TS 产物: ${DAG_MODULE}`);
  console.error("[gen_fixture] 请先构建 packages/deep-engine(pnpm --filter @bim-studio/deep-engine build)。");
  process.exit(1);
}
if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) {
  console.error("[gen_fixture] 仅支持小端平台(fixture 以 LE 字节存档)。");
  process.exit(1);
}
// Windows 盘符路径(D:\…)不是合法 ESM 说明符,必须走 file:// URL。
const { buildMeshletDag } = await import(pathToFileURL(DAG_MODULE).href);

/** 确定性经纬球面网格,可选波形扰动(无随机数,输出逐位可复现)。 */
function buildSphere(segments, rings, jitter) {
  const positions = [];
  const indices = [];
  for (let r = 0; r <= rings; r += 1) {
    const phi = (r / rings) * Math.PI;
    for (let s = 0; s <= segments; s += 1) {
      const theta = (s / segments) * Math.PI * 2;
      const radius = 1 + jitter * Math.sin(6 * phi) * Math.cos(4 * theta);
      positions.push(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.sin(theta),
      );
    }
  }
  const row = segments + 1;
  for (let r = 0; r < rings; r += 1) {
    for (let s = 0; s < segments; s += 1) {
      const a = r * row + s;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      if (r > 0) indices.push(a, c, b);
      if (r < rings - 1) indices.push(b, c, d);
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

const b64 = (view) => Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64");

/** f32 值写 OBJ:9 位有效十进制足以保证 float32 round-trip。 */
const f32Text = (value) => Number(value.toPrecision(9)).toString();

function writeObj(file, geometry, comment) {
  const lines = [`# ${comment}`];
  for (let i = 0; i < geometry.positions.length; i += 3) {
    lines.push(`v ${f32Text(geometry.positions[i])} ${f32Text(geometry.positions[i + 1])} ${f32Text(geometry.positions[i + 2])}`);
  }
  for (let i = 0; i < geometry.indices.length; i += 3) {
    lines.push(`f ${geometry.indices[i] + 1} ${geometry.indices[i + 1] + 1} ${geometry.indices[i + 2] + 1}`);
  }
  writeFileSync(file, lines.join("\n") + "\n");
}

function exportGolden(name, geometry, options) {
  const dag = buildMeshletDag(geometry, options);
  const payload = {
    format: "deep-engine.meshlet-dag-golden/1",
    generator: "gen_fixture.mjs (TS buildMeshletDag, dist/geometry esbuild 产物)",
    options: { levels: options.levels, maxTriangles: options.maxTriangles ?? 64 },
    input: {
      vertexCount: geometry.positions.length / 3,
      triangleCount: geometry.indices.length / 3,
      positionsB64: b64(geometry.positions),
      indicesB64: b64(geometry.indices),
    },
    levels: dag.levels.map((level) => ({
      level: level.level,
      error: level.error,
      meshletCount: level.meshletCount,
      triangleCount: level.indices.length / 3,
      positionsB64: b64(level.positions),
      indicesB64: b64(level.indices),
      descriptorsB64: b64(level.descriptors),
      vertexRemapB64: b64(level.vertexRemap),
      localTriangleIndicesB64: b64(level.localTriangleIndices),
      boundsB64: b64(level.bounds),
      sourceTrianglesB64: b64(level.sourceTriangles),
      clusterSourceSpansB64: b64(level.clusterSourceSpans),
    })),
    parentsByLevel: dag.parentsByLevel.map((parents) => Array.from(parents)),
  };
  writeFileSync(path.join(FIXTURES, `${name}.golden.json`), JSON.stringify(payload));
  return dag;
}

mkdirSync(FIXTURES, { recursive: true });

// 快测资产:TS 单测同款 24x12 球(576 三角形),全链路秒级,CI 先跑。
const quick = buildSphere(24, 12, 0.0);
writeObj(path.join(FIXTURES, "quick_sphere.obj"), quick, "quick sphere 24x12 (deterministic)");
const quickDag = exportGolden("quick_sphere", quick, { levels: 4 });
console.log(`[gen_fixture] quick_sphere: ${quick.indices.length / 3} tris -> ${quickDag.levels.length} levels, ` +
  quickDag.levels.map((l) => l.indices.length / 3).join("/"));

// 5 万三角形主资产:250x100 环带 + 波形扰动(无随机数)。
const main = buildSphere(250, 100, 0.1);
// 经纬网格极点行各只有下半/上半三角形:2·segments·(rings-1) - 2·segments = 49500,而非 rings·segments·2。
const expectedTris = 2 * 250 * (100 - 1);
if (main.indices.length / 3 !== expectedTris) throw new Error(`期望 ${expectedTris} 三角形,实际 ${main.indices.length / 3}`);
writeObj(path.join(FIXTURES, "synthetic50k.obj"), main, "synthetic sphere 250x100 + waveform jitter (50000 triangles)");
const mainDag = exportGolden("synthetic50k", main, { levels: 4 });
console.log(`[gen_fixture] synthetic50k: ${main.indices.length / 3} tris -> ${mainDag.levels.length} levels, ` +
  mainDag.levels.map((l) => l.indices.length / 3).join("/"));
console.log("[gen_fixture] 完成,fixtures 已写入", FIXTURES);
