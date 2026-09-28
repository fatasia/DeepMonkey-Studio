import { describe, expect, it } from "vitest";
import { bakeClusterLodDag } from "./clusterLodBake.js";
import { clusterScreenError, selectClusterLod, CLUSTER_LOD_DEFAULT_PIXEL_THRESHOLD,
  type ClusterLodCamera } from "./clusterLodSelection.js";
import { lookAtView, multiplyMatrix, perspectiveProjection } from "../webgpu/instanceVisibilityReference.js";
import { measureSilhouetteDeviation, rasterizeSilhouetteMask } from "./clusterLodSilhouette.js";

/**
 * T05 验收切片：轮廓屏幕误差 ≤1px（指定冻结视图）。
 * 方法：确定性 CPU 光栅化（softRasterizeReference 像素中心采样）分别光栅 L0 参考几何与
 * 阈值=1px 选层前沿几何（按前沿节点 firstTriangle/triangleCount 取各自层几何）的剪影掩码，
 * 双向轮廓 Chebyshev 偏差 ≤1px 判定。机位由 l1 误差投影反推（≈0.95px → 前沿选中 l1）。
 */

const VIEWPORT = [480, 270] as const, FOV = Math.PI / 4, ASPECT = VIEWPORT[0]! / VIEWPORT[1]!;

function ridgeMesh(): { vertices: Float32Array; indices: Uint32Array } {
  const nx = 64, nz = 32, stride = nx + 1;
  const vertices = new Float32Array(stride * (nz + 1) * 3);
  for (let z = 0; z <= nz; z++) for (let x = 0; x <= nx; x++) {
    const height = 2.4 * Math.exp(-((x - 32) ** 2) / 220) * (0.55 + 0.45 * Math.sin(x * 0.9) * Math.cos(z * 0.55));
    vertices.set([x, height, z], (z * stride + x) * 3);
  }
  const indices: number[] = [];
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const a = z * stride + x, b = a + 1, c = a + stride, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  return { vertices, indices: Uint32Array.from(indices) };
}

function viewProjection(eye: readonly [number, number, number]): Float32Array {
  return Float32Array.from(multiplyMatrix(perspectiveProjection(FOV, ASPECT, 1, 40_000),
    lookAtView(eye, [32, 0, 16], [0, 1, 0])));
}

function lodCamera(eye: readonly [number, number, number],
  threshold = CLUSTER_LOD_DEFAULT_PIXEL_THRESHOLD): ClusterLodCamera {
  const raw = [(32 - eye[0]), (0 - eye[1]), (16 - eye[2])] as const;
  const length = Math.hypot(...raw);
  return { position: eye, forward: [raw[0] / length, raw[1] / length, raw[2] / length],
    viewportHeightPixels: VIEWPORT[1]!, tanHalfFovY: Math.tan(FOV / 2), pixelThreshold: threshold };
}

/** 反推机位：沿视线后退到 l1 层误差 ≈ fraction×阈值（l1 error = 网格 bbox/8 的聚类 cell）。 */
function eyeForL1ScreenError(dag: ReturnType<typeof bakeClusterLodDag>["dag"], fraction: number):
  readonly [number, number, number] {
  const l1 = dag.nodes.find(node => node.id === "l1-c0")!;
  const distance = l1.error * VIEWPORT[1]! / (2 * Math.tan(FOV / 2) * CLUSTER_LOD_DEFAULT_PIXEL_THRESHOLD * fraction);
  return [32, 0.6 * distance, 16 + 0.8 * distance];
}

/** 前沿掩码：逐前沿节点按 firstTriangle/triangleCount 取其层几何光栅化后取并集。 */
function frontierMask(baked: ReturnType<typeof bakeClusterLodDag>,
  selection: ReturnType<typeof selectClusterLod>, eye: readonly [number, number, number]) {
  const projection = { viewProjection: viewProjection(eye), viewport: VIEWPORT };
  let mask: Uint8Array | undefined, width = 0, height = 0;
  for (const id of selection.frontier) {
    const node = baked.dag.nodes.find(candidate => candidate.id === id)!;
    const level = baked.levelGeometry[node.level]!;
    const indices = new Uint32Array(level.indices.subarray(node.firstTriangle * 3,
      (node.firstTriangle + node.triangleCount) * 3));
    const part = rasterizeSilhouetteMask(level.vertices, indices, projection);
    if (!mask) { mask = part.mask; width = part.width; height = part.height; continue; }
    for (let index = 0; index < mask.length; index++) mask[index] ||= part.mask[index]!;
  }
  if (!mask) throw new Error("Cluster LOD frontier produced no geometry.");
  return { mask, width, height };
}

describe("T05 cluster LOD silhouette screen error (frozen view)", () => {
  const mesh = ridgeMesh();
  const baked = bakeClusterLodDag({ geometryId: "t05-silhouette-ridge", vertices: mesh.vertices,
    indices: mesh.indices, level0ClusterSize: 128, levelCount: 3 });

  it("frontier at L0 reproduces the reference silhouette exactly", () => {
    const eye: readonly [number, number, number] = [32, 14, 44];
    const selection = selectClusterLod(baked.dag, lodCamera(eye));
    expect(Math.max(...selection.screenErrors)).toBeGreaterThan(CLUSTER_LOD_DEFAULT_PIXEL_THRESHOLD);
    expect(selection.frontier.every(id => id.startsWith("l0-"))).toBe(true);
    const reference = rasterizeSilhouetteMask(mesh.vertices, mesh.indices,
      { viewProjection: viewProjection(eye), viewport: VIEWPORT });
    const selected = frontierMask(baked, selection, eye);
    const deviation = measureSilhouetteDeviation(reference.mask, selected.mask, VIEWPORT[0]!, VIEWPORT[1]!);
    expect(deviation.maxDeviationPx).toBe(0);
    expect(deviation.referenceCovered).toBeGreaterThan(0);
  });

  it("frontier with l1 selected keeps silhouette deviation within 1px", () => {
    const eye = eyeForL1ScreenError(baked.dag, 0.95);
    const camera = lodCamera(eye);
    const l1Error = clusterScreenError(baked.dag.nodes.find(node => node.id === "l1-c0")!, camera);
    expect(l1Error).toBeGreaterThan(0.5);
    expect(l1Error).toBeLessThan(CLUSTER_LOD_DEFAULT_PIXEL_THRESHOLD);
    const selection = selectClusterLod(baked.dag, camera);
    expect(selection.frontier.some(id => id.startsWith("l1-"))).toBe(true);
    const reference = rasterizeSilhouetteMask(mesh.vertices, mesh.indices,
      { viewProjection: viewProjection(eye), viewport: VIEWPORT });
    const selected = frontierMask(baked, selection, eye);
    const deviation = measureSilhouetteDeviation(reference.mask, selected.mask, VIEWPORT[0]!, VIEWPORT[1]!);
    expect(deviation.selectedCovered).toBeGreaterThan(0);
    expect(deviation.maxDeviationPx).toBeLessThanOrEqual(1);
  });

  it("camera inside the DAG bounds refines conservatively instead of mis-selecting", () => {
    const eye: readonly [number, number, number] = [32, 0.2, 16];
    const selection = selectClusterLod(baked.dag, lodCamera(eye));
    // 视轴深度被钳到 MIN_VIEW_DEPTH → 屏幕误差放大 → 全部下钻到叶层，绝不误选粗层。
    expect(selection.frontier.every(id => id.startsWith("l0-"))).toBe(true);
  });
});
