/**
 * CPU 参考 BVH 构建/遍历（波次1 合同的仲裁实现）。
 * 中位数分裂（质心最长轴），无 SAH——确定性优先、构建 O(n log n)；WGSL 软件后端与
 * Native 硬件后端的命中结果都以本实现对拍（同一射线→同一 t/prim，容差按合同）。
 * 节点布局即 WGSL storage buffer 布局：4 float bounds + 4 uint meta，32 字节对齐。
 */

export interface BvhNode {
  /** 内部节点：左右子节点索引；叶子：三角形起始/数量。bounds 恒为整棵子树的包围盒。 */
  readonly leftFirst: number;
  readonly count: number;
  /** 内部节点专用：右子节点索引（递归构建中与 leftFirst 不相邻）。 */
  readonly rightChild?: number;
  readonly minX: number; readonly minY: number; readonly minZ: number;
  readonly maxX: number; readonly maxY: number; readonly maxZ: number;
}

export interface BvhBuildResult {
  readonly nodes: ReadonlyArray<BvhNode>;
  /** 重排后的三角形索引（indices 下标）；空几何为空数组。 */
  readonly order: ReadonlyArray<number>;
}

export interface BvhBuildInput {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
}

export function buildBvh(input: BvhBuildInput): BvhBuildResult {
  const triangles = input.indices.length / 3;
  if (triangles === 0) return { nodes: Object.freeze([]), order: Object.freeze([]) };
  const centroids = new Float32Array(triangles * 3);
  const bounds: number[][] = [];
  for (let triangle = 0; triangle < triangles; triangle++) {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let cx = 0, cy = 0, cz = 0;
    for (let corner = 0; corner < 3; corner++) {
      const v = input.indices[triangle * 3 + corner]! * 3;
      const x = input.vertices[v]!, y = input.vertices[v + 1]!, z = input.vertices[v + 2]!;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      cx += x; cy += y; cz += z;
    }
    centroids[triangle * 3] = cx / 3; centroids[triangle * 3 + 1] = cy / 3; centroids[triangle * 3 + 2] = cz / 3;
    bounds.push([minX, minY, minZ, maxX, maxY, maxZ]);
  }
  const nodes: BvhNode[] = [];
  const order: number[] = Array.from({ length: triangles }, (_, i) => i);
  const build = (first: number, count: number): number => {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = first; i < first + count; i++) {
      const b = bounds[order[i]!]!;
      minX = Math.min(minX, b[0]!); minY = Math.min(minY, b[1]!); minZ = Math.min(minZ, b[2]!);
      maxX = Math.max(maxX, b[3]!); maxY = Math.max(maxY, b[4]!); maxZ = Math.max(maxZ, b[5]!);
    }
    const nodeIndex = nodes.length;
    nodes.push({ leftFirst: first, count, minX, minY, minZ, maxX, maxY, maxZ });
    if (count <= 4) return nodeIndex;
    const extentX = maxX - minX, extentY = maxY - minY, extentZ = maxZ - minZ;
    const axis = extentX >= extentY && extentX >= extentZ ? 0 : extentY >= extentZ ? 1 : 2;
    const center = axis === 0 ? (minX + maxX) / 2 : axis === 1 ? (minY + maxY) / 2 : (minZ + maxZ) / 2;
    let left = first, right = first + count - 1;
    while (left <= right) {
      const centroid = axis === 0 ? centroids[order[left]! * 3]! : axis === 1 ? centroids[order[left]! * 3 + 1]! : centroids[order[left]! * 3 + 2]!;
      if (centroid < center) { left += 1; continue; }
      const swap = order[left]!; order[left] = order[right]!; order[right] = swap; right -= 1;
    }
    const leftCount = Math.max(1, Math.min(count - 1, left - first));
    const leftIndex = build(first, leftCount);
    const rightIndex = build(first + leftCount, count - leftCount);
    nodes[nodeIndex] = { leftFirst: leftIndex, rightChild: rightIndex, count: 0, minX, minY, minZ, maxX, maxY, maxZ };
    return nodeIndex;
  };
  build(0, triangles);
  return { nodes: Object.freeze(nodes), order: Object.freeze(order) };
}

/** Möller–Trumbore；返回 t 或 -1。合同仲裁用单精度语义与 WGSL 对齐（普通 f32 运算）。 */
export function intersectTriangle(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  v0: Float32Array, i0: number, i1: number, i2: number): number {
  const e1x = v0[i1 * 3]! - v0[i0 * 3]!, e1y = v0[i1 * 3 + 1]! - v0[i0 * 3 + 1]!, e1z = v0[i1 * 3 + 2]! - v0[i0 * 3 + 2]!;
  const e2x = v0[i2 * 3]! - v0[i0 * 3]!, e2y = v0[i2 * 3 + 1]! - v0[i0 * 3 + 1]!, e2z = v0[i2 * 3 + 2]! - v0[i0 * 3 + 2]!;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-20) return -1;
  const inv = 1 / det;
  const tx = ox - v0[i0 * 3]!, ty = oy - v0[i0 * 3 + 1]!, tz = oz - v0[i0 * 3 + 2]!;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}
