/**
 * H-C7-P4 基准 D2:视锥剔除验证(CPU 空间索引,1000 对象)。
 *
 * 证明范围(纯 CPU,不冒充 GPU 证据):
 * - 正确性:LooseOctreeIndex.queryFrustum 结果集合与逐对象 aabbIntersectsFrustum
 *   全扫集合逐 id 一致(远/近两档相机,不同剔除率);
 * - 性能登记:两路径每查询平均耗时与剔除率(参考数值,非帧时合同)。
 * 生产消费链(CpuVisibleWorkingSet/ScreenSpaceLodSelector)不在本样例重复验收。
 */
import * as THREE from "three";
import {
  aabbIntersectsFrustum,
  LooseOctreeIndex,
  validateSpatialFrustum,
  type SpatialAabb,
  type SpatialFrustum,
} from "../../../src/spatial/index.js";

const COUNT = 1000;
const SPACING = 2;

// 20×10×5 网格散布,1m³ 包围盒。
const octree = new LooseOctreeIndex({
  bounds: { min: [-4, -4, -4], max: [20 * SPACING + 4, 10 * SPACING + 4, 5 * SPACING + 4] },
});
const boxes: SpatialAabb[] = [];
for (let index = 0; index < COUNT; index += 1) {
  const x = (index % 20) * SPACING;
  const y = Math.floor(index / 20) % 10 * SPACING;
  const z = Math.floor(index / 200) * SPACING;
  const bounds: SpatialAabb = { min: [x, y, z], max: [x + 1, y + 1, z + 1] };
  octree.insert(`obj-${index}`, bounds);
  boxes.push(bounds);
}

/** three 相机 → SpatialFrustum。three Frustum 平面约定 n·p + constant ≥ 0 为内,
 * 与 SpatialPlane [x,y,z,distance](aabbIntersectsFrustum 内点 ≥0)一致,直取。 */
function frustumFromCamera(camera: THREE.PerspectiveCamera): SpatialFrustum {
  const projection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const three = new THREE.Frustum().setFromProjectionMatrix(projection);
  return validateSpatialFrustum({
    planes: three.planes.map((plane): [number, number, number, number] =>
      [plane.normal.x, plane.normal.y, plane.normal.z, plane.constant]),
  });
}

const makeCamera = (position: [number, number, number]): THREE.PerspectiveCamera => {
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 400);
  camera.position.set(...position);
  camera.lookAt(20, 8, 4);
  camera.updateMatrixWorld(true);
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  return camera;
};

const failures: string[] = [];
const timings: Array<{ label: string; visible: number; cullRatio: string; octreeQueryMs: number; fullScanMs: number; consistent: boolean }> = [];
for (const [label, position] of [["far", [70, 45, 70]], ["near", [8, 3, 8]]] as const) {
  const camera = makeCamera(position as unknown as [number, number, number]);
  const frustum = frustumFromCamera(camera);

  // 正确性:两路径集合逐 id 一致。
  const viaOctree = new Set(octree.queryFrustum(frustum).ids);
  const viaScan = new Set<string>();
  for (let index = 0; index < COUNT; index += 1) {
    if (aabbIntersectsFrustum(boxes[index]!, frustum)) viaScan.add(`obj-${index}`);
  }
  let consistent = viaOctree.size === viaScan.size;
  if (consistent) for (const id of viaScan) if (!viaOctree.has(id)) { consistent = false; break; }
  if (!consistent) failures.push(`${label}: octree=${viaOctree.size} scan=${viaScan.size}`);

  // 性能:各 400 次查询平均。
  const bench = (run: () => void, rounds: number): number => {
    const start = performance.now();
    for (let round = 0; round < rounds; round += 1) run();
    return (performance.now() - start) / rounds;
  };
  const octreeQueryMs = bench(() => void octree.queryFrustum(frustum), 400);
  const fullScanMs = bench(() => {
    for (let index = 0; index < COUNT; index += 1) aabbIntersectsFrustum(boxes[index]!, frustum);
  }, 400);
  timings.push({
    label, visible: viaScan.size, cullRatio: `${(1 - viaScan.size / COUNT).toFixed(3)}`,
    octreeQueryMs: +octreeQueryMs.toFixed(4), fullScanMs: +fullScanMs.toFixed(4), consistent,
  });
}

const report = {
  bench: "d2-frustum-cull",
  objectCount: COUNT,
  timings,
  failures,
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  caliber: "cpu-spatial-query (not gpu draw-call evidence)",
  gpuExecuted: false, browserExecuted: false,
};
console.log(JSON.stringify(report, null, 2));
if (report.verdict === "FAIL") throw new Error(`d2 bench failed: ${failures.join("; ")}`);
