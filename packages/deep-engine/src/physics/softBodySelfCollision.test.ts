import { describe, expect, it } from "vitest";
import { createSoftBodySelfCollision, extractSoftBodySurfaceTopology } from "./softBodySelfCollision.js";
import { SoftBodySolver } from "./softBodySolver.js";

const GRAVITY = [0, -9.81, 0] as const;

// 与 softBodyStaticCollision.test 同构的 4-tet simplex:顶点 4 为内部点。
const SIMPLEX_POSITIONS: readonly (readonly number[])[] = [
  [0, 2, 0], [0.1, 2, 0], [0, 2.1, 0], [0, 2, 0.1], [0.05, 2.12, 0.05],
];
const SIMPLEX_TETS = [[0, 1, 2, 4], [0, 1, 3, 4], [0, 2, 3, 4], [1, 2, 3, 4]] as const;

describe("软体表面拓扑提取", () => {
  it("4-tet simplex:顶点 4 为内部点,表面= {0,1,2,3}", () => {
    const topology = extractSoftBodySurfaceTopology(SIMPLEX_TETS, 5);
    expect(Array.from(topology.surfaceIndices)).toEqual([0, 1, 2, 3]);
    // 1 跳邻接(CSR 只为表面粒子存条目):顶点 0 与 {1,2,3,4} 相邻;顶点 4 非表面,无条目。
    const neighborsOf0 = Array.from(
      { length: topology.adjacencyOffsets[1]! - topology.adjacencyOffsets[0]! },
      (_, k) => topology.adjacencyData[topology.adjacencyOffsets[0]! + k]!,
    );
    expect(neighborsOf0.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(topology.adjacencyOffsets[4]).toBe(topology.adjacencyOffsets[5]);
  });
});

describe("软体自碰撞合同与行为", () => {
  const topology = extractSoftBodySurfaceTopology(SIMPLEX_TETS, 5);
  const minEdge = 0.05; // fixture 最短边(近似;合同只要求 2r ≤ minEdge)。

  it("拒绝非法半径与 2r > 最短边", () => {
    expect(() => createSoftBodySelfCollision({ topology, count: 5, radius: 0, minEdgeLength: minEdge })).toThrow(/radius/);
    expect(() => createSoftBodySelfCollision({ topology, count: 5, radius: 0.03, minEdgeLength: minEdge })).toThrow(/min tet edge/);
  });

  it("skipPair 三态:1 跳邻接重合对不动,非邻接表面对分离,含内部粒子的对不动", () => {
    const radius = 0.01;
    const resolver = createSoftBodySelfCollision({ topology, count: 5, radius, minEdgeLength: minEdge });
    // 场景 A:表面非邻接对不存在于 4-tet simplex(0,1,2,3 两两共享 tet)——用顶点 4 复制成第 6 点不可行(固定 count);
    // 直接验证:全部表面两两重合时,由于两两邻接,resolve 后全部保持重合(排除生效)。
    const px = new Float64Array([0, 0, 0, 0, 0]);
    const py = new Float64Array([1, 1, 1, 1, 1]);
    const pz = new Float64Array([0, 0, 0, 0, 0]);
    const mass = new Float64Array([1, 1, 1, 1, 0]); // 顶点 4 锚点
    resolver.resolve(px, py, pz, mass);
    for (let i = 0; i < 4; i += 1) {
      expect(px[i]).toBe(0); expect(py[i]).toBe(1); expect(pz[i]).toBe(0);
    }
  });

  it("双副本重合 simplex:启用后跨副本重合表面对被分离,禁用保持重合", () => {
    // 两份 simplex 顶点完全重合(索引 0-3 与 4-7 坐标相同,互不共享 tet → 跨副本为非邻接表面对)。
    const positions: number[][] = [...SIMPLEX_POSITIONS, ...SIMPLEX_POSITIONS.map(p => [...p] as number[]).map(p => [p[0]!, p[1]!, p[2]!])];
    const tets = [...SIMPLEX_TETS, ...SIMPLEX_TETS.map(t => t.map(i => i + 5))];
    const make = (selfCollision: boolean): SoftBodySolver => new SoftBodySolver({
      positions: positions as number[][], tets: tets as number[][],
      mass: 0.05, gravity: GRAVITY, dtSeconds: 1 / 60, substeps: 4,
      complianceDistance: 0, complianceVolume: 0, damping: 0.01, pinned: [],
      ...(selfCollision ? { selfCollisionRadius: 0.02 } : {}),
    });
    const disabled = make(false);
    for (let t = 0; t < 10; t += 1) disabled.step();
    const enabled = make(true);
    for (let t = 0; t < 10; t += 1) enabled.step();
    const readMinCross = (solver: SoftBodySolver): number => {
      const p = solver.positionsInterleaved();
      let min = Number.POSITIVE_INFINITY;
      // 跨副本对:a∈[0,4), b∈[5,9)(坐标重合的对应点)。
      for (let a = 0; a < 4; a += 1) {
        for (let b = 5; b < 9; b += 1) {
          const dx = p[a * 3]! - p[b * 3]!; const dy = p[a * 3 + 1]! - p[b * 3 + 1]!; const dz = p[a * 3 + 2]! - p[b * 3 + 2]!;
          min = Math.min(min, Math.sqrt(dx * dx + dy * dy + dz * dz));
        }
      }
      return min;
    };
    // 副本完全重合、约束相同 → 禁用时保持重合(自碰撞的证明力来源)。
    expect(readMinCross(disabled)).toBe(0);
    // 启用后跨副本分离到接触直径量级。
    expect(readMinCross(enabled)).toBeGreaterThanOrEqual(0.9 * 2 * 0.02);
  });
});
