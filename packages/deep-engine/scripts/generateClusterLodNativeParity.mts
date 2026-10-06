/**
 * Cluster LOD 选层 native 对拍 fixture 生成器(TS 侧)。
 *
 * 单源 fixture:packages/deep-engine/fixtures/cluster-lod-native-parity-v1.json
 *   - cases ≥3:黄金网格 quick_sphere(gen_fixture 同源 positions/indices)经
 *     bakeClusterLodDag → selectClusterLod 生产 CPU 权威输出(selection u32 /
 *     screenErrors f32 量化 / frontier DFS 序列);三相机覆盖近/远/阈值边界。
 *   - Rust 侧 gpu_cluster_lod_selection_tests 读同一 fixture 位级对拍
 *     (selection u32 逐字、screen_errors f32 词逐字、frontier 顺序一致)。
 *
 * 运行:仓库根 `node_modules/.bin/tsx packages/deep-engine/scripts/generateClusterLodNativeParity.mts`
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const importMetaDirname = dirname(fileURLToPath(import.meta.url));
import { bakeClusterLodDag } from "../src/rayTracing/clusterLodBake.js";
import { selectClusterLod, type ClusterLodCamera, type ClusterLodNodeDescriptor } from "../src/rayTracing/clusterLodSelection.js";

const golden = JSON.parse(
  readFileSync(
    resolve(importMetaDirname, "../../deep-engine-native/geometry_dag/tests/fixtures/quick_sphere.golden.json"),
    "utf8",
  ),
) as {
  input: { vertexCount: number; triangleCount: number; positionsB64: string; indicesB64: string };
  options: { levels: number };
};

const positions = Buffer.from(golden.input.positionsB64, "base64");
const indicesBytes = Buffer.from(golden.input.indicesB64, "base64");
const vertices = new Float32Array(
  positions.buffer.slice(positions.byteOffset, positions.byteOffset + positions.byteLength),
);
const indices = new Uint32Array(
  indicesBytes.buffer.slice(indicesBytes.byteOffset, indicesBytes.byteOffset + indicesBytes.byteLength),
);

const bake = bakeClusterLodDag({
  geometryId: "quick_sphere",
  vertices,
  indices,
  level0ClusterSize: 64,
  levelCount: golden.options.levels,
});

interface Case {
  name: string;
  camera: ClusterLodCamera;
}

const cases: Case[] = [
  {
    name: "near-threshold-edge",
    camera: { position: [1, 1, 6], forward: [-0.12, -0.12, -0.985], viewportHeightPixels: 1080, tanHalfFovY: 0.5, pixelThreshold: 2 },
  },
  {
    name: "far-coarse",
    camera: { position: [8, 6, 24], forward: [-0.28, -0.2, -0.936], viewportHeightPixels: 720, tanHalfFovY: 0.7, pixelThreshold: 8 },
  },
  {
    name: "tight-threshold-refine",
    camera: { position: [1, 1, 3], forward: [0, 0, -1], viewportHeightPixels: 2160, tanHalfFovY: 0.45, pixelThreshold: 0.5 },
  },
];

const fixture = {
  schema: "deep-engine.cluster-lod-native-parity/1",
  cases: cases.map(({ name, camera }) => {
    const result = selectClusterLod(bake.dag as unknown as Parameters<typeof selectClusterLod>[0], camera);
    return {
      name,
      camera,
      nodes: (bake.dag.nodes as readonly ClusterLodNodeDescriptor[]).map(node => ({
        id: node.id,
        level: node.level,
        error: node.error,
        boundsMin: node.boundsMin,
        boundsMax: node.boundsMax,
        firstTriangle: node.firstTriangle,
        triangleCount: node.triangleCount,
        children: [...node.children],
      })),
      expectedSelection: Array.from(result.selection),
      expectedScreenErrorsF32: Array.from(result.screenErrors),
      expectedFrontier: [...result.frontier],
    };
  }),
};

const out = resolve(importMetaDirname, "../../deep-engine-native/fixtures/cluster-lod-native-parity-v1.json");
writeFileSync(out, JSON.stringify(fixture));
console.log(`cluster-lod parity fixture regenerated: ${fixture.cases.length} cases -> ${out}`);
