/**
 * 生成 BVH 构建的跨端 golden fixture：确定性网格输入 → 节点布局 + order。
 * Rust 侧 ray_backend::tests::matches_ts_golden_fixture 读取该文件逐值比对，
 * 任何一侧构建语义漂移都会使另一侧的比对失败（identityGolden 模式）。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { buildBvh } from "../src/rayTracing/bvhBuilder.js";

const CELLS = 8;
const STRIDE = CELLS + 1;
const vertices = new Float32Array(STRIDE * STRIDE * 3);
for (let y = 0; y < STRIDE; y++) {
  for (let x = 0; x < STRIDE; x++) {
    vertices.set([x, y, Math.sin(x * 13.7 + y * 7.3)], (y * STRIDE + x) * 3);
  }
}
const indices: number[] = [];
for (let y = 0; y < CELLS; y++) {
  for (let x = 0; x < CELLS; x++) {
    const a = y * STRIDE + x, b = a + 1, c = a + STRIDE, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
}
const built = buildBvh({ vertices, indices: Uint32Array.from(indices) });
const fixture = {
  schema: "deep-monkey.bvh-golden.v1",
  input: { cells: CELLS, generator: "grid(x,y,sin(13.7x+7.3y))" },
  // 顶点由 TS 生成并存档：两侧 sin/浮点实现不同，输入必须共享而不是各自重算。
  vertices: [...vertices],
  indices: [...indices],
  nodes: built.nodes.map(node => ({
    leftFirst: node.leftFirst, count: node.count, ...(node.rightChild !== undefined ? { rightChild: node.rightChild } : {}),
    minX: node.minX, minY: node.minY, minZ: node.minZ, maxX: node.maxX, maxY: node.maxY, maxZ: node.maxZ,
  })),
  order: [...built.order],
};
const outDir = resolve(import.meta.dirname ?? ".", "../fixtures/rayTracing");
mkdirSync(outDir, { recursive: true });
const out = resolve(outDir, "bvh-golden.json");
writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
console.log(`wrote ${out} (${fixture.nodes.length} nodes, ${fixture.order.length} triangles)`);
