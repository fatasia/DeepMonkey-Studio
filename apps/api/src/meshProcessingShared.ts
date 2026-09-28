import type { Accessor } from "@gltf-transform/core";
import { MeshoptSimplifier } from "meshoptimizer";

/**
 * T12 几何处理切片(拓扑检查 / 法线重算 / 公差简化)共用的确定性原语。
 * 只做纯计算,不做 I/O;同输入必同输出。
 */

/** 单条 issue 采样定位符上限;超出只累计 count,不展开,保证报告体积有界。 */
export const MESH_SAMPLE_LIMIT = 8;

export interface Vec3Like {
  0: number;
  1: number;
  2: number;
}

type PositionRemapFn = (vertexPositions: Float32Array, vertexPositionsStride: number) => Uint32Array;

/**
 * 位置完全一致(bit 级)的顶点归并到同一规范索引。
 * 优先 meshoptimizer 的 generatePositionRemap(1.0.1 运行时已确认存在,
 * 但 .d.ts 未声明,这里以受控类型收敛);不可用时回退纯 JS 精确键映射,两者同为确定性。
 */
export async function positionRemap(positions: Float32Array): Promise<Uint32Array> {
  if (positions.length % 3 !== 0) throw new Error("positionRemap: positions 长度必须是 3 的倍数");
  await MeshoptSimplifier.ready;
  const simplifier = MeshoptSimplifier as unknown as { generatePositionRemap?: PositionRemapFn };
  if (typeof simplifier.generatePositionRemap === "function") {
    return simplifier.generatePositionRemap(positions, 3);
  }
  return exactPositionRemap(positions);
}

function exactPositionRemap(positions: Float32Array): Uint32Array {
  const vertexCount = positions.length / 3;
  const remap = new Uint32Array(vertexCount);
  const firstSeen = new Map<string, number>();
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const key = exactPositionKey(positions, vertex);
    const seen = firstSeen.get(key);
    if (seen === undefined) {
      firstSeen.set(key, vertex);
      remap[vertex] = vertex;
    } else {
      remap[vertex] = seen;
    }
  }
  return remap;
}

function exactPositionKey(positions: Float32Array, vertex: number): string {
  const x = positions[vertex * 3]!;
  const y = positions[vertex * 3 + 1]!;
  const z = positions[vertex * 3 + 2]!;
  const nx = x === 0 ? 0 : x;
  const ny = y === 0 ? 0 : y;
  const nz = z === 0 ? 0 : z;
  if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) return `#${vertex}`;
  return `${nx}|${ny}|${nz}`;
}

/** 轴对齐包围盒对角线长度;与 meshoptimizer getScale 的语义无关,只用于本仓退化阈值。 */
export function aabbDiagonal(positions: ArrayLike<number>): number {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let offset = 0; offset + 2 < positions.length; offset += 3) {
    const x = positions[offset]!, y = positions[offset + 1]!, z = positions[offset + 2]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return 0;
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
}

/** positions 中非有限坐标的个数(检测类调用先于任何 meshopt 调用)。 */
export function countNonFinite(positions: ArrayLike<number>): number {
  let count = 0;
  for (let offset = 0; offset < positions.length; offset += 1) {
    if (!Number.isFinite(positions[offset]!)) count += 1;
  }
  return count;
}

/** 非单位化叉积(模长 = 2·面积),供面积加权与退化判定共用。 */
export function triangleCross(
  positions: ArrayLike<number>,
  a: number,
  b: number,
  c: number,
): [number, number, number] {
  const ax = positions[a * 3]!, ay = positions[a * 3 + 1]!, az = positions[a * 3 + 2]!;
  const bx = positions[b * 3]!, by = positions[b * 3 + 1]!, bz = positions[b * 3 + 2]!;
  const cx = positions[c * 3]!, cy = positions[c * 3 + 1]!, cz = positions[c * 3 + 2]!;
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/** 角点 a 处的内角(弧度);入射边任一长度为 0 时返回 0。 */
export function angleAtCorner(
  positions: ArrayLike<number>,
  a: number,
  b: number,
  c: number,
): number {
  const ab = edgeVector(positions, a, b);
  const ac = edgeVector(positions, a, c);
  const lengthAB = Math.hypot(ab[0], ab[1], ab[2]);
  const lengthAC = Math.hypot(ac[0], ac[1], ac[2]);
  if (lengthAB === 0 || lengthAC === 0) return 0;
  const cosine = (ab[0] * ac[0] + ab[1] * ac[1] + ab[2] * ac[2]) / (lengthAB * lengthAC);
  return Math.acos(Math.min(1, Math.max(-1, cosine)));
}

function edgeVector(positions: ArrayLike<number>, from: number, to: number): [number, number, number] {
  return [
    positions[to * 3]! - positions[from * 3]!,
    positions[to * 3 + 1]! - positions[from * 3 + 1]!,
    positions[to * 3 + 2]! - positions[from * 3 + 2]!,
  ];
}

/** 无符号规范化边键(两端点排序拼接);入参为规范顶点索引。 */
export function canonicalEdgeKey(a: number, b: number): string {
  return a <= b ? `${a}_${b}` : `${b}_${a}`;
}

/** 无符号规范化三角形键(三点排序拼接)。 */
export function canonicalTriangleKey(a: number, b: number, c: number): string {
  const sorted = [a, b, c].sort((left, right) => left - right);
  return `${sorted[0]}_${sorted[1]}_${sorted[2]}`;
}

/** 点到三角形的最小距离平方(Ericson, Real-Time Collision Detection §5.1.5)。 */
export function pointTriangleDistanceSquared(
  point: Vec3Like,
  a: Vec3Like,
  b: Vec3Like,
  c: Vec3Like,
): number {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(point, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return dot(ap, ap);
  const bp = sub(point, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return dot(bp, bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return dot(ap, ap) - v * d1;
  }
  const cp = sub(point, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return dot(cp, cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return dot(ap, ap) - w * d2;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + d5 - d6);
    return dot(bp, bp) + w * dot(cp, cp) - w * d4;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  const closest = [
    a[0] + ab[0] * v + ac[0] * w,
    a[1] + ab[1] * v + ac[1] * w,
    a[2] + ab[2] * v + ac[2] * w,
  ] as const;
  return distanceSquared(point, closest);
}

function sub(a: Vec3Like, b: Vec3Like): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vec3Like, b: Vec3Like): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function distanceSquared(a: Vec3Like, b: Vec3Like): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

/** glTF 索引解码为 Uint32Array(已归一化或非常规标量类型时逐元素读取)。 */
export function decodeScalarIndices(accessor: Accessor): Uint32Array {
  const count = accessor.getCount();
  const out = new Uint32Array(count);
  const array = accessor.getArray();
  if (!accessor.getNormalized()
    && (array instanceof Uint32Array || array instanceof Uint16Array || array instanceof Uint8Array)) {
    for (let index = 0; index < count; index += 1) out[index] = array[index]!;
    return out;
  }
  for (let index = 0; index < count; index += 1) out[index] = accessor.getScalar(index);
  return out;
}

/** glTF POSITION/NORMAL 解码为连续 Float32Array(count*3)。 */
export function decodeVec3Attribute(accessor: Accessor): Float32Array {
  const count = accessor.getCount();
  const out = new Float32Array(count * 3);
  const array = accessor.getArray();
  if (array instanceof Float32Array && !accessor.getNormalized()) {
    out.set(array.subarray(0, count * 3));
    return out;
  }
  const element = [0, 0, 0];
  for (let index = 0; index < count; index += 1) {
    accessor.getElement(index, element);
    out[index * 3] = element[0]!;
    out[index * 3 + 1] = element[1]!;
    out[index * 3 + 2] = element[2]!;
  }
  return out;
}
