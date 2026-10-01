/**
 * N10 窄相位:两凸体最近点对距离(GJK 距离子例程)。
 * 纯标量实现——热路径零对象分配(支撑查询返回复用缓冲),固定迭代序、无随机源,
 * 同输入双跑逐位一致。算法口径见 docs/specs/n10-narrow-phase-sweep-20261001.md §3:
 * 支撑映射直接吃顶点集/解析球,查询期不构建凸包(T17 quickhull 仍服务离线 collider 生成)。
 * EPA 穿透深度不在本切片:穿透只返回布尔,不输出接触点(接触集不唯一,诚实边界)。
 */

/** 刚体变换:平移 + (x,y,z,w) 四元数。 */
export interface RigidTransform {
  translation: readonly [number, number, number];
  rotationQuaternion: readonly [number, number, number, number];
}

/** 平移变换捷径。 */
export function translationTransform(translation: readonly [number, number, number]): RigidTransform {
  return { translation, rotationQuaternion: [0, 0, 0, 1] };
}

/** URDF origin(xyz + 固定轴 XYZ 欧拉 rpy)→ 刚体变换;按 URDF 标准四元数 qz(yaw)·qy(pitch)·qx(roll)。 */
export function transformFromUrdfOrigin(xyz: readonly [number, number, number], rpy: readonly [number, number, number]): RigidTransform {
  const [roll, pitch, yaw] = rpy;
  // 半角四元数逐分量展开,避免构造中间对象。
  const cx = Math.cos(roll / 2), sx = Math.sin(roll / 2);
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
  const w = cx * cp * cy + sx * sp * sy;
  const x = sx * cp * cy - cx * sp * sy;
  const y = cx * sp * cy + sx * cp * sy;
  const z = cx * cp * sy - sx * sp * cy;
  return { translation: [xyz[0], xyz[1], xyz[2]], rotationQuaternion: [x, y, z, w] };
}

/**
 * 凸形状:顶点集(body 局部系,扁平 xyz)或解析球(球心 = 体原点)。
 * box/cylinder 由调用方顶点化(见 convexShapeFromUrdfGeometry);mesh 凸体直接传顶点集。
 */
export type ConvexShape =
  | { kind: "vertices"; vertices: readonly number[] }
  | { kind: "sphere"; radius: number };

export interface ConvexDistanceOptions {
  /** 距离绝对容差(米);同时是 touch/穿透判据。默认 1e-9。 */
  absoluteTolerance?: number;
  /** 相对收敛容差(相对 |v|)。默认 1e-6。 */
  relativeTolerance?: number;
  /** GJK 迭代上限。默认 64。 */
  maxIterations?: number;
}

/** 分离:距离与两侧最近点(世界系,距离 = |pointA − pointB|)。 */
export interface ConvexDistanceSeparated {
  separated: true;
  distance: number;
  pointA: readonly [number, number, number];
  pointB: readonly [number, number, number];
}

/** 碰撞(含 touch):距离按 0 计;接触集不唯一,不输出接触点。 */
export interface ConvexDistanceColliding {
  separated: false;
  distance: 0;
}

export type ConvexDistanceResult = ConvexDistanceSeparated | ConvexDistanceColliding;

export interface BodyBoundingSphere {
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
}

/** 世界系凸体:顶点集已变换展开,球体记录世界心。由 toWorldBody 构造,供热路径复用。 */
export interface WorldConvexBody {
  kind: "vertices" | "sphere";
  /** vertices 形态:世界系扁平 xyz。 */
  vertices: Float64Array;
  /** sphere 形态:世界心与半径。 */
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
  /** 保守包围球(完全包含凸体),供宽相剪枝。 */
  bounding: BodyBoundingSphere;
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} 必须是有限数值,得到 ${value}`);
}

function normalizeQuaternion(q: readonly [number, number, number, number], label: string): readonly [number, number, number, number] {
  const [x, y, z, w] = q;
  assertFinite(x, `${label}.x`); assertFinite(y, `${label}.y`); assertFinite(z, `${label}.z`); assertFinite(w, `${label}.w`);
  const length = Math.hypot(x, y, z, w);
  if (length <= 1e-12) throw new Error(`${label} 四元数模长为零,无法归一`);
  return [x / length, y / length, z / length, w / length];
}

/** 形状 + 变换 → 世界系凸体(顶点一次性展开,包围球保守)。 */
export function toWorldBody(shape: ConvexShape, transform: RigidTransform): WorldConvexBody {
  if (!shape || (shape.kind !== "vertices" && shape.kind !== "sphere")) throw new Error("凸形状 kind 非法");
  const [tx, ty, tz] = transform.translation;
  assertFinite(tx, "变换平移.x"); assertFinite(ty, "变换平移.y"); assertFinite(tz, "变换平移.z");
  const [qx, qy, qz, qw] = normalizeQuaternion(transform.rotationQuaternion, "变换旋转");
  if (shape.kind === "sphere") {
    assertFinite(shape.radius, "球半径");
    if (shape.radius <= 0) throw new Error(`球半径必须为正,得到 ${shape.radius}`);
    return {
      kind: "sphere", vertices: new Float64Array(0),
      centerX: tx, centerY: ty, centerZ: tz, radius: shape.radius,
      bounding: { centerX: tx, centerY: ty, centerZ: tz, radius: shape.radius },
    };
  }
  const local = shape.vertices;
  if (!local || local.length === 0 || local.length % 3 !== 0) throw new Error("顶点集必须是非空的扁平 xyz 数组");
  // 旋转矩阵(四元数 → 3x3)。
  const r00 = 1 - 2 * (qy * qy + qz * qz), r01 = 2 * (qx * qy - qz * qw), r02 = 2 * (qx * qz + qy * qw);
  const r10 = 2 * (qx * qy + qz * qw), r11 = 1 - 2 * (qx * qx + qz * qz), r12 = 2 * (qy * qz - qx * qw);
  const r20 = 2 * (qx * qz - qy * qw), r21 = 2 * (qy * qz + qx * qw), r22 = 1 - 2 * (qx * qx + qy * qy);
  const world = new Float64Array(local.length);
  // 包围球:中心取顶点均值(变换后),半径 = 最大顶点距(保守)。
  let meanX = 0, meanY = 0, meanZ = 0;
  for (let index = 0; index < local.length; index += 3) {
    const x = local[index]!, y = local[index + 1]!, z = local[index + 2]!;
    assertFinite(x, `顶点[${index / 3}].x`); assertFinite(y, `顶点[${index / 3}].y`); assertFinite(z, `顶点[${index / 3}].z`);
    meanX += x; meanY += y; meanZ += z;
  }
  const count = local.length / 3;
  meanX /= count; meanY /= count; meanZ /= count;
  let radiusSq = 0;
  for (let index = 0; index < local.length; index += 3) {
    const x = local[index]!, y = local[index + 1]!, z = local[index + 2]!;
    const dx = x - meanX, dy = y - meanY, dz = z - meanZ;
    radiusSq = Math.max(radiusSq, dx * dx + dy * dy + dz * dz);
    world[index] = r00 * x + r01 * y + r02 * z + tx;
    world[index + 1] = r10 * x + r11 * y + r12 * z + ty;
    world[index + 2] = r20 * x + r21 * y + r22 * z + tz;
  }
  const centerX = r00 * meanX + r01 * meanY + r02 * meanZ + tx;
  const centerY = r10 * meanX + r11 * meanY + r12 * meanZ + ty;
  const centerZ = r20 * meanX + r21 * meanY + r22 * meanZ + tz;
  return {
    kind: "vertices", vertices: world,
    centerX: 0, centerY: 0, centerZ: 0, radius: 0,
    bounding: { centerX, centerY, centerZ, radius: Math.sqrt(radiusSq) },
  };
}

/** URDF collisions 几何 → 凸形状:box 8 顶点、sphere 解析、cylinder 沿局部 Z 24 段顶点化(URDF 标准轴向)。 */
export type UrdfLikeGeometry =
  | { type: "box"; size: { x: number; y: number; z: number } }
  | { type: "sphere"; radius: number }
  | { type: "cylinder"; radius: number; length: number }
  | { type: "mesh"; filename: string; resolvedPath: string; scale: { x: number; y: number; z: number } };

export function convexShapeFromUrdfGeometry(geometry: UrdfLikeGeometry): ConvexShape {
  if (!geometry || typeof geometry.type !== "string") throw new Error("URDF 几何无效");
  if (geometry.type === "sphere") {
    if (!(geometry.radius > 0)) throw new Error("URDF 球几何半径必须为正");
    return { kind: "sphere", radius: geometry.radius };
  }
  if (geometry.type === "box") {
    const { x, y, z } = geometry.size;
    if (!(x > 0 && y > 0 && z > 0)) throw new Error("URDF 盒几何尺寸必须为正");
    const hx = x / 2, hy = y / 2, hz = z / 2;
    return {
      kind: "vertices",
      vertices: [
        -hx, -hy, -hz, hx, -hy, -hz, -hx, hy, -hz, hx, hy, -hz,
        -hx, -hy, hz, hx, -hy, hz, -hx, hy, hz, hx, hy, hz,
      ],
    };
  }
  if (geometry.type === "cylinder") {
    if (!(geometry.radius > 0 && geometry.length > 0)) throw new Error("URDF 圆柱几何半径与长度必须为正");
    // 24 段顶点化(URDF 圆柱沿局部 Z);曲面近似,最大支撑误差 r·(1 − cos(π/24)) ≈ 0.86%·r,显式声明非精确。
    const segments = 24;
    const half = geometry.length / 2;
    const vertices: number[] = [];
    for (let index = 0; index < segments; index++) {
      const angle = (index / segments) * Math.PI * 2;
      const c = Math.cos(angle) * geometry.radius;
      const s = Math.sin(angle) * geometry.radius;
      vertices.push(c, s, -half, c, s, half);
    }
    return { kind: "vertices", vertices };
  }
  throw new Error(
    `URDF mesh 几何不在窄相位直接支持范围:请先经 T17 凸包管线(apps/api physicsColliderSource)产出凸包顶点,以 vertices 形态传入`,
  );
}

// ─── GJK 距离子例程 ─────────────────────────────────────────────────────────────

interface GjkOptions {
  absTol: number;
  relTol: number;
  maxIterations: number;
}

function resolveOptions(options?: ConvexDistanceOptions): GjkOptions {
  const absTol = options?.absoluteTolerance ?? 1e-9;
  const relTol = options?.relativeTolerance ?? 1e-6;
  const maxIterations = options?.maxIterations ?? 64;
  if (!(absTol > 0) || !Number.isFinite(absTol)) throw new Error("绝对容差必须是正有限数");
  if (!(relTol > 0) || relTol >= 1 || !Number.isFinite(relTol)) throw new Error("相对容差必须在 (0,1) 内");
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 4096) throw new Error("迭代上限必须是 1..4096 的整数");
  return { absTol, relTol, maxIterations };
}

/** 支撑点写入共享缓冲,避免热路径分配。 */
const supportBuffer = new Float64Array(3);

function supportVertices(body: WorldConvexBody, dx: number, dy: number, dz: number): void {
  const vertices = body.vertices;
  let bestIndex = 0;
  let bestDot = vertices[0]! * dx + vertices[1]! * dy + vertices[2]! * dz;
  for (let index = 3; index < vertices.length; index += 3) {
    const dot = vertices[index]! * dx + vertices[index + 1]! * dy + vertices[index + 2]! * dz;
    if (dot > bestDot) {
      bestDot = dot;
      bestIndex = index;
    }
  }
  supportBuffer[0] = vertices[bestIndex]!;
  supportBuffer[1] = vertices[bestIndex + 1]!;
  supportBuffer[2] = vertices[bestIndex + 2]!;
}

function supportBody(body: WorldConvexBody, dx: number, dy: number, dz: number, out: Float64Array, offset: number): void {
  if (body.kind === "sphere") {
    out[offset] = body.centerX + body.radius * dx;
    out[offset + 1] = body.centerY + body.radius * dy;
    out[offset + 2] = body.centerZ + body.radius * dz;
    return;
  }
  supportVertices(body, dx, dy, dz);
  out[offset] = supportBuffer[0]!;
  out[offset + 1] = supportBuffer[1]!;
  out[offset + 2] = supportBuffer[2]!;
}

/** 单纯形条目:CSO 点 w = a − b,并缓存两侧支撑点用于最近点对提取。 */
interface SimplexEntry {
  wx: number; wy: number; wz: number;
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
}

function makeEntry(ax: number, ay: number, az: number, bx: number, by: number, bz: number): SimplexEntry {
  return { wx: ax - bx, wy: ay - by, wz: az - bz, ax, ay, az, bx, by, bz };
}

/** 求单纯形(1..3 点)上离原点最近的点;返回坐标与 barycentric 权重。 */
function closestOnSimplex(entries: SimplexEntry[]): { x: number; y: number; z: number; bary: number[] } {
  if (entries.length === 1) {
    const only = entries[0]!;
    return { x: only.wx, y: only.wy, z: only.wz, bary: [1] };
  }
  if (entries.length === 2) {
    const a = entries[0]!, b = entries[1]!;
    const abx = b.wx - a.wx, aby = b.wy - a.wy, abz = b.wz - a.wz;
    const denominator = abx * abx + aby * aby + abz * abz;
    if (denominator <= 1e-30) return closestOnSimplex([a]);
    // t = clamp(−A·AB / |AB|², 0, 1)(P = 原点)。
    const t = Math.min(1, Math.max(0, -(a.wx * abx + a.wy * aby + a.wz * abz) / denominator));
    return {
      x: a.wx + abx * t, y: a.wy + aby * t, z: a.wz + abz * t,
      bary: t >= 1 ? [0, 1] : [1 - t, t],
    };
  }
  // 三角形情形(Ericson ClosestPtPointTriangle,P = 原点,含 barycentric)。
  const a = entries[0]!, b = entries[1]!, c = entries[2]!;
  const abx = b.wx - a.wx, aby = b.wy - a.wy, abz = b.wz - a.wz;
  const acx = c.wx - a.wx, acy = c.wy - a.wy, acz = c.wz - a.wz;
  // ap = 原点 − A = −A。
  const apx = -a.wx, apy = -a.wy, apz = -a.wz;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return { x: a.wx, y: a.wy, z: a.wz, bary: [1, 0, 0] };
  const bpx = -b.wx, bpy = -b.wy, bpz = -b.wz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return { x: b.wx, y: b.wy, z: b.wz, bary: [0, 1, 0] };
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    return { x: a.wx + abx * t, y: a.wy + aby * t, z: a.wz + abz * t, bary: [1 - t, t, 0] };
  }
  const cpx = -c.wx, cpy = -c.wy, cpz = -c.wz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return { x: c.wx, y: c.wy, z: c.wz, bary: [0, 0, 1] };
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    return { x: a.wx + acx * t, y: a.wy + acy * t, z: a.wz + acz * t, bary: [1 - t, 0, t] };
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + d5 - d6);
    return { x: b.wx + (c.wx - b.wx) * t, y: b.wy + (c.wy - b.wy) * t, z: b.wz + (c.wz - b.wz) * t, bary: [0, 1 - t, t] };
  }
  // 内点分支:重心坐标;退化(共线,va+vb+vc ≈ 0)时回退三条边取最近,防除零 NaN。
  const total = va + vb + vc;
  if (Number.isFinite(total) && total > 1e-30) {
    const denominator = 1 / total;
    const v = va * denominator, w = vb * denominator, u = vc * denominator;
    return {
      x: a.wx * v + b.wx * w + c.wx * u,
      y: a.wy * v + b.wy * w + c.wy * u,
      z: a.wz * v + b.wz * w + c.wz * u,
      bary: [v, w, u],
    };
  }
  const edges: Array<[SimplexEntry, SimplexEntry]> = [[a, b], [a, c], [b, c]];
  let best = closestOnSimplex([a]);
  for (const [p, q] of edges) {
    const candidate = closestOnSimplex([p, q]);
    if (candidate.x * candidate.x + candidate.y * candidate.y + candidate.z * candidate.z
      < best.x * best.x + best.y * best.y + best.z * best.z) best = candidate;
  }
  return best;
}

/**
 * 原点是否在四面体内(逐面与对顶点同侧判定,免绕序)。
 * 零体积/近退化守卫:对顶点恰在面平面内(共面四面体)时 sideOpposite 是浮点噪声,
 * 噪声符号会伪装成"异侧/同侧"——生产缺陷实锤(共面 CSO 点被判包含,距离 3.75 m 报成碰撞)。
 * 处理:面法向长度作尺度,|sideOpposite| 低于相对阈值的面"不可判";全部不可判(零体积)
 * 按非包含处理,交由最近面缩减继续迭代。
 */
function originInsideTetrahedron(entries: SimplexEntry[]): boolean {
  let extent = 0;
  for (const entry of entries) {
    extent = Math.max(extent, Math.abs(entry.wx), Math.abs(entry.wy), Math.abs(entry.wz));
  }
  if (extent <= 1e-30) return false;
  const faces: Array<[number, number, number]> = [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]];
  let decided = 0;
  for (const [i, j, k] of faces) {
    const opposite = 0 + 1 + 2 + 3 - i - j - k;
    const p = entries[i]!, q = entries[j]!, r = entries[k]!, o = entries[opposite]!;
    const e1x = q.wx - p.wx, e1y = q.wy - p.wy, e1z = q.wz - p.wz;
    const e2x = r.wx - p.wx, e2y = r.wy - p.wy, e2z = r.wz - p.wz;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const normalLength = Math.hypot(nx, ny, nz);
    if (normalLength <= 1e-30) continue; // 零面积面
    const sideOpposite = nx * (o.wx - p.wx) + ny * (o.wy - p.wy) + nz * (o.wz - p.wz);
    // 6 倍面体积(边叉积 × 对顶点边投影)低于坐标量级的 1e-12 → 该面不可判。
    if (Math.abs(sideOpposite) <= 1e-12 * normalLength * extent) continue;
    const sideOrigin = -(nx * p.wx + ny * p.wy + nz * p.wz);
    if (sideOpposite > 0 && sideOrigin < 0) return false;
    if (sideOpposite < 0 && sideOrigin > 0) return false;
    decided += 1;
  }
  return decided > 0;
}

/** 四面体不含原点:对 4 个面分别求最近点,保留距离最小的面(3 条目)。 */
function reduceTetrahedronToClosestFace(entries: SimplexEntry[]): void {
  const faces: Array<[number, number, number]> = [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]];
  let best: { face: [number, number, number]; distanceSq: number } | undefined;
  for (const face of faces) {
    const single = face.map(index => entries[index]!);
    const closest = closestOnSimplex(single);
    const distanceSq = closest.x * closest.x + closest.y * closest.y + closest.z * closest.z;
    if (!best || distanceSq < best.distanceSq) best = { face, distanceSq };
  }
  const kept = best!.face.map(index => entries[index]!);
  entries.length = 0;
  entries.push(kept[0]!, kept[1]!, kept[2]!);
}

/**
 * GJK 距离:两世界凸体的最近点对。分离时输出精确距离(上下界夹紧收敛)与最近点;
 * |v| ≤ absTol 或单纯形包含原点 → 碰撞。同输入双跑逐位一致。
 * 记号:v = 原点到 CSO(A⊖B)当前最近点的向量;Minkowski 支撑
 * w = argmax_u(a) − argmax_{−u}(b)(对 B 取反方向,初版笔误已修,同族排查仅此两处支撑调用)。
 */
export function convexDistance(a: WorldConvexBody, b: WorldConvexBody, options?: ConvexDistanceOptions): ConvexDistanceResult {
  const { absTol, relTol, maxIterations } = resolveOptions(options);
  const supportA = new Float64Array(3);
  const supportB = new Float64Array(3);
  // 初始方向:包围球心差;退化取固定 +X。
  let dx = a.bounding.centerX - b.bounding.centerX;
  let dy = a.bounding.centerY - b.bounding.centerY;
  let dz = a.bounding.centerZ - b.bounding.centerZ;
  if (dx * dx + dy * dy + dz * dz < 1e-24) {
    dx = 1; dy = 0; dz = 0;
  }
  const directionLength = Math.hypot(dx, dy, dz);
  dx /= directionLength; dy /= directionLength; dz /= directionLength;
  supportBody(a, dx, dy, dz, supportA, 0);
  supportBody(b, -dx, -dy, -dz, supportB, 0);
  const entries: SimplexEntry[] = [makeEntry(supportA[0]!, supportA[1]!, supportA[2]!, supportB[0]!, supportB[1]!, supportB[2]!)];
  let closest = closestOnSimplex(entries);
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const vx = closest.x, vy = closest.y, vz = closest.z;
    const vNorm = Math.hypot(vx, vy, vz);
    if (vNorm <= absTol) return { separated: false, distance: 0 };
    // 搜索方向:−v(单位化),指向原点。
    const ux = -vx / vNorm, uy = -vy / vNorm, uz = -vz / vNorm;
    supportBody(a, ux, uy, uz, supportA, 0);
    supportBody(b, -ux, -uy, -uz, supportB, 0);
    const wx = supportA[0]! - supportB[0]!, wy = supportA[1]! - supportB[1]!, wz = supportA[2]! - supportB[2]!;
    // 收敛:v 的支撑投影已无法再靠近原点(|v| − (v·w)/|v| ≤ rel·|v| + abs)。
    const projection = (vx * wx + vy * wy + vz * wz) / vNorm;
    if (vNorm - projection <= relTol * vNorm + absTol) {
      return { separated: true, distance: vNorm, pointA: closestPointOnA(entries, closest.bary), pointB: closestPointOnB(entries, closest.bary) };
    }
    // 退化守卫:新支撑点与已有条目重复 → 已到 CSO 边界平台,按当前值收敛。
    let duplicate = false;
    for (const entry of entries) {
      const ex = wx - entry.wx, ey = wy - entry.wy, ez = wz - entry.wz;
      if (ex * ex + ey * ey + ez * ez <= 1e-24) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) {
      return { separated: true, distance: vNorm, pointA: closestPointOnA(entries, closest.bary), pointB: closestPointOnB(entries, closest.bary) };
    }
    entries.push(makeEntry(supportA[0]!, supportA[1]!, supportA[2]!, supportB[0]!, supportB[1]!, supportB[2]!));
    if (entries.length === 4) {
      if (originInsideTetrahedron(entries)) return { separated: false, distance: 0 };
      reduceTetrahedronToClosestFace(entries);
    }
    closest = closestOnSimplex(entries);
  }
  // 迭代耗尽:按当前最优分离值返回(不冒充收敛;调用方可用更松容差重查)。
  const vx = closest.x, vy = closest.y, vz = closest.z;
  const vNorm = Math.hypot(vx, vy, vz);
  if (vNorm <= absTol) return { separated: false, distance: 0 };
  return { separated: true, distance: vNorm, pointA: closestPointOnA(entries, closest.bary), pointB: closestPointOnB(entries, closest.bary) };
}

function closestPointOnA(entries: SimplexEntry[], bary: number[]): readonly [number, number, number] {
  let x = 0, y = 0, z = 0;
  for (let index = 0; index < entries.length; index++) {
    const weight = bary[index]!;
    x += entries[index]!.ax * weight;
    y += entries[index]!.ay * weight;
    z += entries[index]!.az * weight;
  }
  return [x, y, z];
}

function closestPointOnB(entries: SimplexEntry[], bary: number[]): readonly [number, number, number] {
  let x = 0, y = 0, z = 0;
  for (let index = 0; index < entries.length; index++) {
    const weight = bary[index]!;
    x += entries[index]!.bx * weight;
    y += entries[index]!.by * weight;
    z += entries[index]!.bz * weight;
  }
  return [x, y, z];
}

// ---------------------------------------------------------------------------
// EPA(Expanding Polytope Algorithm):穿透对的 MTD 深度/方向与接触点。
// 输入约定:仅接受严格穿透(原点在 CSO 内部);切触由 GJK 分离路径处理。
// ---------------------------------------------------------------------------

interface EpaTriangle {
  a: SimplexEntry;
  b: SimplexEntry;
  c: SimplexEntry;
  nx: number;
  ny: number;
  nz: number;
  /** 原点到三角形平面的距离(法向已朝外,值非负)。 */
  dist: number;
}

/** 三角形外向法向与原点距离;退化(零面积)返回 null。 */
function epaTriangle(a: SimplexEntry, b: SimplexEntry, c: SimplexEntry): EpaTriangle | null {
  const e1x = b.wx - a.wx, e1y = b.wy - a.wy, e1z = b.wz - a.wz;
  const e2x = c.wx - a.wx, e2y = c.wy - a.wy, e2z = c.wz - a.wz;
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const length = Math.hypot(nx, ny, nz);
  if (!(length > 1e-30)) return null;
  const ux = nx / length, uy = ny / length, uz = nz / length;
  const dist = -(ux * a.wx + uy * a.wy + uz * a.wz);
  return { a, b, c, nx: ux, ny: uy, nz: uz, dist };
}

/** 法向翻转朝外(原点在多面体内 ⇒ 外向 = 远离原点一侧,dist ≥ 0)。 */
function orientOutward(triangle: EpaTriangle): EpaTriangle {
  if (triangle.dist < 0) {
    return { a: triangle.a, b: triangle.c, c: triangle.b, nx: -triangle.nx, ny: -triangle.ny, nz: -triangle.nz, dist: -triangle.dist };
  }
  return triangle;
}

/** GJK 循环直到四面体包含原点(仅碰撞态可达);返回 4 条目。 */
function gjkTetrahedronForEpa(a: WorldConvexBody, b: WorldConvexBody, absTol: number, maxIterations: number): SimplexEntry[] {
  const supportA = new Float64Array(3);
  const supportB = new Float64Array(3);
  let dx = a.bounding.centerX - b.bounding.centerX;
  let dy = a.bounding.centerY - b.bounding.centerY;
  let dz = a.bounding.centerZ - b.bounding.centerZ;
  if (dx * dx + dy * dy + dz * dz < 1e-24) { dx = 1; dy = 0; dz = 0; }
  const startLength = Math.hypot(dx, dy, dz);
  dx /= startLength; dy /= startLength; dz /= startLength;
  supportBody(a, dx, dy, dz, supportA, 0);
  supportBody(b, -dx, -dy, -dz, supportB, 0);
  const entries: SimplexEntry[] = [makeEntry(supportA[0]!, supportA[1]!, supportA[2]!, supportB[0]!, supportB[1]!, supportB[2]!)];
  let closest = closestOnSimplex(entries);
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const vx = closest.x, vy = closest.y, vz = closest.z;
    const vNorm = Math.hypot(vx, vy, vz);
    const ux = -vx / vNorm, uy = -vy / vNorm, uz = -vz / vNorm;
    supportBody(a, ux, uy, uz, supportA, 0);
    supportBody(b, -ux, -uy, -uz, supportB, 0);
    const entry = makeEntry(supportA[0]!, supportA[1]!, supportA[2]!, supportB[0]!, supportB[1]!, supportB[2]!);
    if (entries.some(existing => {
      const ex = entry.wx - existing.wx, ey = entry.wy - existing.wy, ez = entry.wz - existing.wz;
      return ex * ex + ey * ey + ez * ez <= 1e-24;
    })) break; // CSO 边界平台:切触态,EPA 直接路径不适用,交由轴系兜底。
    entries.push(entry);
    if (entries.length === 4 && originInsideTetrahedron(entries)) return entries;
    if (entries.length === 4) reduceTetrahedronToClosestFace(entries);
    closest = closestOnSimplex(entries);
    if (vNorm <= absTol && entries.length < 4) break; // 切触态。
  }
  throw new Error("EPA direct tetrahedron unavailable; falling back to axis reconstruction");
}

/** 轴系候选方向构建包含原点的初始四面体(切触/退化兜底)。 */
function initialEpaPolytope(a: WorldConvexBody, b: WorldConvexBody): EpaTriangle[] {
  const directions: Array<readonly [number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 1, 1], [-1, -1, -1]];
  const supportA = new Float64Array(3);
  const supportB = new Float64Array(3);
  const entries: SimplexEntry[] = [];
  for (const [ux, uy, uz] of directions) {
    supportBody(a, ux, uy, uz, supportA, 0);
    supportBody(b, -ux, -uy, -uz, supportB, 0);
    const entry = makeEntry(supportA[0]!, supportA[1]!, supportA[2]!, supportB[0]!, supportB[1]!, supportB[2]!);
    if (!entries.some(existing => {
      const ex = entry.wx - existing.wx, ey = entry.wy - existing.wy, ez = entry.wz - existing.wz;
      return ex * ex + ey * ey + ez * ez <= 1e-24;
    })) entries.push(entry);
    if (entries.length === 4 && originInsideTetrahedron(entries)) break;
  }
  if (entries.length < 4 || !originInsideTetrahedron(entries)) {
    throw new Error("convexPenetration could not build a containing tetrahedron (touch or degenerate overlap)");
  }
  return epaTetrahedronFaces(entries);
}

/** 四面体 → 四个外向绕序三角形(对顶点在面法向负侧)。 */
function epaTetrahedronFaces(entries: SimplexEntry[]): EpaTriangle[] {
  const faces: Array<[number, number, number]> = [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]];
  const triangles: EpaTriangle[] = [];
  for (const [i, j, k] of faces) {
    const opposite = 0 + 1 + 2 + 3 - i - j - k;
    const raw = epaTriangle(entries[i]!, entries[j]!, entries[k]!)!;
    const o = entries[opposite]!;
    const side = raw.nx * (o.wx - raw.a.wx) + raw.ny * (o.wy - raw.a.wy) + raw.nz * (o.wz - raw.a.wz);
    triangles.push(side > 0
      ? { a: raw.a, b: raw.c, c: raw.b, nx: -raw.nx, ny: -raw.ny, nz: -raw.nz, dist: -raw.dist }
      : raw);
  }
  return triangles;
}

export interface ConvexPenetration {
  /** MTD 深度(把 B 沿 normal 平移 depth 后两体恰好分离)。 */
  depth: number;
  /** 单位 MTD 方向(把 B 推离 A 的方向)。 */
  normal: readonly [number, number, number];
  /** A 表面接触点(世界系,MTD 支撑平面上)。 */
  pointA: readonly [number, number, number];
  /** B 表面接触点(世界系)。 */
  pointB: readonly [number, number, number];
  /** false = 迭代/多面体上限内未收敛,depth 为当前下界(不冒充精确值)。 */
  converged: boolean;
}

/**
 * EPA:穿透对的 minimum translation vector 与接触点。
 * 前置:convexDistance 报告碰撞且为严格穿透(切触/边界接触抛错,由调用方守卫)。
 * 同输入双跑逐位一致(无随机源,固定遍历序)。
 */
export function convexPenetration(a: WorldConvexBody, b: WorldConvexBody, options?: ConvexDistanceOptions): ConvexPenetration {
  const { absTol, relTol, maxIterations } = resolveOptions(options);
  const supportA = new Float64Array(3);
  const supportB = new Float64Array(3);
  let polytope: EpaTriangle[];
  try {
    polytope = epaTetrahedronFaces(gjkTetrahedronForEpa(a, b, absTol, maxIterations));
  } catch {
    polytope = initialEpaPolytope(a, b); // 切触/退化兜底:轴系方向重建包含四面体。
  }
  const support = (ux: number, uy: number, uz: number): SimplexEntry => {
    supportBody(a, ux, uy, uz, supportA, 0);
    supportBody(b, -ux, -uy, -uz, supportB, 0);
    return makeEntry(supportA[0]!, supportA[1]!, supportA[2]!, supportB[0]!, supportB[1]!, supportB[2]!);
  };
  let best = polytope.reduce((min, triangle) => (triangle.dist < min.dist ? triangle : min), polytope[0]!);
  const maxTriangles = maxIterations * 16;
  let converged = false;
  for (let iteration = 0; iteration < maxIterations * 4 && polytope.length < maxTriangles; iteration++) {
    // 最近三角形(到原点距离最小);线性扫描保证固定遍历序的确定性。
    let closestIndex = 0;
    for (let index = 1; index < polytope.length; index++) {
      if (polytope[index]!.dist < polytope[closestIndex]!.dist) closestIndex = index;
    }
    best = polytope[closestIndex]!;
    const vertex = support(best.nx, best.ny, best.nz);
    const projection = vertex.wx * best.nx + vertex.wy * best.ny + vertex.wz * best.nz;
    if (projection - best.dist <= relTol * best.dist + absTol) {
      converged = true;
      break;
    }
    // 移除所有朝向新支撑点的三角形,收集地平线边(不被反向边抵消的有向边)。
    const horizon: Array<[SimplexEntry, SimplexEntry]> = [];
    const kept: EpaTriangle[] = [];
    for (const triangle of polytope) {
      const facing = triangle.nx * (vertex.wx - triangle.a.wx) + triangle.ny * (vertex.wy - triangle.a.wy) + triangle.nz * (vertex.wz - triangle.a.wz);
      if (facing > 1e-30) {
        horizon.push([triangle.a, triangle.b], [triangle.b, triangle.c], [triangle.c, triangle.a]);
      } else {
        kept.push(triangle);
      }
    }
    const unique: Array<[SimplexEntry, SimplexEntry]> = [];
    for (const [start, end] of horizon) {
      const reverseExists = horizon.some(([s, e]) => s === end && e === start && s !== end);
      const duplicate = unique.some(([s, e]) => s === start && e === end);
      if (!reverseExists && !duplicate) unique.push([start, end]);
    }
    if (unique.length < 3) { converged = true; break; } // 地平线退化/支撑点在内:按当前值收敛。
    polytope = kept;
    for (const [start, end] of unique) {
      const triangle = epaTriangle(start, end, vertex);
      if (triangle) polytope.push(orientOutward(triangle));
    }
  }
  // 接触点:原点在 MTD 三角形上的投影 barycentric 加权两侧支撑点。
  const closest = closestOnSimplex([best.a, best.b, best.c]);
  return {
    depth: best.dist,
    normal: [best.nx, best.ny, best.nz],
    pointA: closestPointOnA([best.a, best.b, best.c], closest.bary),
    pointB: closestPointOnB([best.a, best.b, best.c], closest.bary),
    converged,
  };
}
