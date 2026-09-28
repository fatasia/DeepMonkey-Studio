/**
 * F6 切片 1:SDF 网格 → 凹体碰撞网格桥(确定性 Marching Tetrahedra)。
 *
 * 选型依据(报告 §选型):Web Rapier 0.19.3 无 convexDecomposition、无 VHACD 入口;
 * 为跨端(web 0.19.3 / native 0.35.3)逐位同构,两端共用同一算法——Kuhn 六四面体
 * 剖分(相邻 cell 共享面剖分逐棱一致,闭合场输出闭合流形)+ 棱交点 f32 插值。
 * 产出直接喂 Rapier `ColliderDesc.trimesh` / `ColliderBuilder::trimesh`
 * (凹 fixed 体 × 凸 dynamic 体是 trimesh 完全支持的接触路径)。
 *
 * 确定性合同:全部坐标/插值运算 Math.fround 收敛到 f32;拓扑查表为纯整数;
 * 遍历序 (z,y,x) 固定 → 同输入同端逐位同输出。跨端逐位一致要求对端 Rust 镜像
 * 保持同一运算顺序(见 packages/deep-engine-native/src/physics_sdf_mesh.rs)。
 *
 * 边界诚实声明:网格采样域边缘一圈按最近内点常值外推,外推区不产生等值面——
 * 源几何必须与网格边界保持 ≥1 cell 间距(buildSdfGrid 调用方职责),否则边界处
 * 表面不闭合,桥以「全场同号 / 流形不闭合」形态暴露而不是静默。
 */
import type { SdfGrid } from "./sdfGrid.js";

/** 提取预算:与运行包 MAX_COLLIDER_INDICES/3 对齐,超限 fail-closed。 */
export const MAX_SDF_COLLISION_TRIANGLES = 65_536;

export interface SdfCollisionMesh {
  /** 顶点 xyz 交叠数组(米;SDF 网格坐标系 = 刚体局部坐标系)。 */
  readonly positions: Float32Array<ArrayBuffer>;
  /** 三角形索引(长度 = 3 × triangleCount)。 */
  readonly indices: Uint32Array<ArrayBuffer>;
  readonly triangleCount: number;
  /** 提取期观测(证据字段):等值面顶点数(共享棱去重后)。 */
  readonly vertexCount: number;
}

const CUBE_CORNERS: readonly (readonly [number, number, number])[] = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];

/** Freudenthal/Kuhn 主对角剖分:每 cell 同表(体对角线 0-6 的六个置换四面体)。
 * 跨 cell 面对角线天然一致(逐面验证:x 面 0-7/1-6、y 面 0-5/3-6、z 面 0-2/4-6),
 * 等值面无 T 形裂缝(测试以流形闭合证明)。 */
const KUHN_TETS: readonly (readonly [number, number, number, number])[] = [
  [0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6],
];

/** tet 本地棱编号(与 TET_EDGES 下标一致)。 */
const E01 = 0, E02 = 1, E03 = 2, E12 = 3, E13 = 4, E23 = 5;

/**
 * 16 mask → 等值面三角形的棱环序(mask 位 i = 顶点 i 在内部,d<0)。
 * 两顶点在内部的 6 个 mask 是四边形:表内按真实等值线段环序给出四条棱
 * (相邻棱必须共 tet 面),拆分固定为 (0,1,2)+(0,2,3) → 每条线段恰配对一次,
 * 输出闭合流形。0/15 全外/全内无面。单顶点形的 3 棱为同一三角形,顺序固定即可。
 */
const MASK_POLYGONS: readonly (readonly number[] | null)[] = [
  null,                   // 0000
  [E01, E02, E03],        // v0 in
  [E01, E12, E13],        // v1 in
  [E02, E03, E13, E12],   // v0,v1 in(quad)
  [E02, E12, E23],        // v2 in
  [E01, E03, E23, E12],   // v0,v2 in(quad)
  [E01, E02, E23, E13],   // v1,v2 in(quad)
  [E03, E13, E23],        // v0,v1,v2 in(v3 out)
  [E03, E23, E13],        // v3 in
  [E01, E02, E23, E13],   // v0,v3 in(quad)
  [E01, E03, E23, E12],   // v1,v3 in(quad)
  [E02, E12, E23],        // v0,v1,v3 in(v2 out)
  [E02, E03, E13, E12],   // v2,v3 in(quad)
  [E01, E12, E13],        // v0,v2,v3 in(v1 out)
  [E01, E02, E03],        // v1,v2,v3 in(v0 out)
  null,                   // 1111
];

const TET_EDGES: readonly (readonly [number, number])[] =
  [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];

/** 与 sdfGrid 的 MAX_CELLS 同源的上限;运行包侧另按 cells 校验 distances 长度。 */
const MAX_GRID_CELLS = 262_144;
/** 棱去重键 = min·2²¹ + max(有衬垫线性点索引 ≤ 129³−1 < 2²¹)。 */
const EDGE_KEY_STRIDE = 2_097_152;

const fround = Math.fround;

/**
 * 从有界 SDF 网格提取零等值面碰撞网格。
 * 距离约定与 sdfGrid 一致:负 = 内部(闭合源几何),正 = 外部;d < 0 判入。
 * 交点参数 t = d_a/(d_a−d_b),位置 = p_a + t·(p_b−p_a),全 f32 逐位;
 * 预算超限抛 RangeError(带实测/上限),绝不静默截断。
 */
export function extractSdfCollisionMesh(
  grid: Pick<SdfGrid, "origin" | "cellSize" | "dimensions" | "distances">,
  options: { maxTriangles?: number } = {},
): SdfCollisionMesh {
  const maxTriangles = options.maxTriangles ?? MAX_SDF_COLLISION_TRIANGLES;
  if (!Number.isSafeInteger(maxTriangles) || maxTriangles < 1) {
    throw new RangeError(`SDF 等值面预算必须是正整数,得到 ${maxTriangles}`);
  }
  const [nx, ny, nz] = grid.dimensions;
  const cells = nx * ny * nz;
  if (![nx, ny, nz].every(value => Number.isSafeInteger(value) && value >= 2 && value <= 128)
    || !Number.isSafeInteger(cells) || cells > MAX_GRID_CELLS
    || grid.distances.length !== cells) {
    throw new RangeError(`SDF 碰撞提取要求有界网格(每维 2..128、cells ≤ ${MAX_GRID_CELLS}),实测 ${nx}×${ny}×${nz}`);
  }
  if (!Number.isFinite(grid.cellSize) || grid.cellSize <= 0 || !grid.origin.every(Number.isFinite)) {
    throw new RangeError("SDF 碰撞提取要求有限正 cellSize 与有限 origin");
  }
  if (grid.distances.some(value => !Number.isFinite(value))) {
    throw new RangeError("SDF 碰撞提取拒绝非有限距离值");
  }

  const positions: number[] = [];
  const indices: number[] = [];
  const edgeVertices = new Map<number, number>();
  const [ox, oy, oz] = grid.origin, cs = grid.cellSize;
  // 采样点坐标与距离一次预取(f32 逐位);衬垫 (nx+1)(ny+1)(nz+1) 点,
  // 域边缘一圈 = 最近内点常值外推(见头部边界诚实声明)。
  const pointCount = (nx + 1) * (ny + 1) * (nz + 1);
  const px = new Float32Array(pointCount);
  const py = new Float32Array(pointCount);
  const pz = new Float32Array(pointCount);
  const pd = new Float32Array(pointCount);
  for (let z = 0; z <= nz; z++) for (let y = 0; y <= ny; y++) for (let x = 0; x <= nx; x++) {
    const point = (z * (ny + 1) + y) * (nx + 1) + x;
    px[point] = fround(ox + x * cs);
    py[point] = fround(oy + y * cs);
    pz[point] = fround(oz + z * cs);
    pd[point] = x < nx && y < ny && z < nz
      ? grid.distances[(z * ny + y) * nx + x]!
      : grid.distances[(Math.min(z, nz - 1) * ny + Math.min(y, ny - 1)) * nx + Math.min(x, nx - 1)]!;
  }

  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const base = (z * (ny + 1) + y) * (nx + 1) + x;
    const cubeD = CUBE_CORNERS.map(([dx, dy, dz]) => pd[base + (dz * (ny + 1) + dy) * (nx + 1) + dx]!);
    const tets = KUHN_TETS;
    for (const tet of tets) {
      const d0 = cubeD[tet[0]!]!, d1 = cubeD[tet[1]!]!, d2 = cubeD[tet[2]!]!, d3 = cubeD[tet[3]!]!;
      let mask = 0;
      if (d0 < 0) mask |= 1;
      if (d1 < 0) mask |= 2;
      if (d2 < 0) mask |= 4;
      if (d3 < 0) mask |= 8;
      const polygon = MASK_POLYGONS[mask];
      if (polygon === undefined || polygon === null) continue;
      // 棱交点按表内环序求取(只算表引用的棱)。
      const crossings: number[] = [];
      for (const edgeIndex of polygon) {
        const a = tet[TET_EDGES[edgeIndex]![0]!]!, b = tet[TET_EDGES[edgeIndex]![1]!]!;
        crossings.push(edgeVertex(base, a, b, cubeD[a]!, cubeD[b]!));
      }
      // 向外定向:trimesh 接触法线取三角形绕向,必须一致朝外(场正侧)。
      // 方向参考 = 首个外部顶点 − 首个内部顶点(按 tet 顶点序取第一对):
      // tet 内场是线性的,任一异侧点对必然横穿零平面,dot 严格非退化
      // (均值规则在 2-in/2-out 且内外均值同层的 tet 上会退化到面内)。
      let firstOut: [number, number, number] | undefined;
      let firstIn: [number, number, number] | undefined;
      for (let vertex = 0; vertex < 4; vertex++) {
        const corner = CUBE_CORNERS[tet[vertex]!]!;
        const point: [number, number, number] = [
          px[base + corner[2]! * ((ny + 1) * (nx + 1)) + corner[1]! * (nx + 1) + corner[0]!]!,
          py[base + corner[2]! * ((ny + 1) * (nx + 1)) + corner[1]! * (nx + 1) + corner[0]!]!,
          pz[base + corner[2]! * ((ny + 1) * (nx + 1)) + corner[1]! * (nx + 1) + corner[0]!]!,
        ];
        if (cubeD[tet[vertex]!]! < 0) firstIn ??= point;
        else firstOut ??= point;
      }
      const reference: [number, number, number] = [
        firstOut![0] - firstIn![0], firstOut![1] - firstIn![1], firstOut![2] - firstIn![2],
      ];
      emitOrientedTriangle(positions, indices, crossings[0]!, crossings[1]!, crossings[2]!, reference);
      if (crossings.length === 4) {
        emitOrientedTriangle(positions, indices, crossings[0]!, crossings[2]!, crossings[3]!, reference);
      }
      if (indices.length + (crossings.length === 4 ? 6 : 3) > maxTriangles * 3) {
        throw new RangeError(`SDF 等值面三角形数将超出预算 ${maxTriangles};请降低网格分辨率或提高预算`);
      }
    }
  }
  if (!indices.length) throw new RangeError("SDF 网格不含零等值面(全场同号);凹体碰撞要求正负距离并存");

  function edgeVertex(base: number, a: number, b: number, da: number, db: number): number {
    const ca = CUBE_CORNERS[a]!, cb = CUBE_CORNERS[b]!;
    const strideY = nx + 1, strideZ = (ny + 1) * strideY;
    const pointA = base + ca[2]! * strideZ + ca[1]! * strideY + ca[0]!;
    const pointB = base + cb[2]! * strideZ + cb[1]! * strideY + cb[0]!;
    const keyA = pointA, keyB = pointB;
    const key = Math.min(keyA, keyB) * EDGE_KEY_STRIDE + Math.max(keyA, keyB);
    const cached = edgeVertices.get(key);
    if (cached !== undefined) return cached;
    const index = positions.length / 3;
    const t = fround(da / fround(da - db));
    positions.push(
      fround(px[pointA]! + t * fround(px[pointB]! - px[pointA]!)),
      fround(py[pointA]! + t * fround(py[pointB]! - py[pointA]!)),
      fround(pz[pointA]! + t * fround(pz[pointB]! - pz[pointA]!)),
    );
    edgeVertices.set(key, index);
    return index;
  }
  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    triangleCount: indices.length / 3,
    vertexCount: positions.length / 3,
  };
}

/** 三角形外向定向:法线 n = (b−a)×(c−a);dot(n, 参考−a) < 0 时交换 (b,c)。
 * 参考点 = tet 外部(d≥0)顶点质心——场正侧即「外」,tet 间的方向由场符号
 * 全局一致传递,故整面 winding 一致。坐标全 f32;仅索引顺序受影响。 */
function emitOrientedTriangle(
  positions: number[], indices: number[], a: number, b: number, c: number,
  reference: readonly [number, number, number],
): void {
  const px0 = positions[a * 3]!, py0 = positions[a * 3 + 1]!, pz0 = positions[a * 3 + 2]!;
  const e1x = positions[b * 3]! - px0, e1y = positions[b * 3 + 1]! - py0, e1z = positions[b * 3 + 2]! - pz0;
  const e2x = positions[c * 3]! - px0, e2y = positions[c * 3 + 1]! - py0, e2z = positions[c * 3 + 2]! - pz0;
  const nx = e1y * e2z - e1z * e2y, nyy = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const dot = nx * (reference[0] - px0) + nyy * (reference[1] - py0) + nz * (reference[2] - pz0);
  indices.push(a, ...(dot < 0 ? [c, b] as const : [b, c] as const));
}

/**
 * 运行包 sdf-grid collider 载荷(已通过 validateDynamicSceneRuntime)→ 提取网格输入。
 * distances 以 JSON number[] 传输,这里转回 Float32Array(f32 往返无损:JSON 十进制
 * 最短表示 parse 回同一 f64,再收敛到同一 f32)。
 */
export function sdfColliderPayloadToGrid(sdf: {
  readonly origin: readonly [number, number, number];
  readonly cellSize: number;
  readonly dimensions: readonly [number, number, number];
  readonly distances: readonly number[];
}): Pick<SdfGrid, "origin" | "cellSize" | "dimensions" | "distances"> {
  const cells = sdf.dimensions[0] * sdf.dimensions[1] * sdf.dimensions[2];
  if (sdf.distances.length !== cells) {
    throw new RangeError(`sdf-grid distances 长度 ${sdf.distances.length} 与网格 ${cells} 不一致`);
  }
  return {
    origin: sdf.origin, cellSize: sdf.cellSize, dimensions: sdf.dimensions,
    distances: Float32Array.from(sdf.distances),
  };
}
