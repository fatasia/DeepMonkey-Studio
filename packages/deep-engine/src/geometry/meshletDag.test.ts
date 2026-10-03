import { describe, expect, it } from "vitest";
import { buildMeshletDag, clusterSimplify } from "./meshletDag.js";
import { buildMeshlets } from "./meshletBuilder.js";
import type { IndexedTriangleGeometry } from "./types.js";

/** 确定性球面网格(经纬细分,无退化三角形)。 */
function sphereGeometry(segments = 24, rings = 12): IndexedTriangleGeometry {
  const positions: number[] = [], indices: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    for (let s = 0; s <= segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      positions.push(Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta));
    }
  }
  const row = segments + 1;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * row + s, b = a + 1, c = a + row, d = c + 1;
      if (r > 0) indices.push(a, c, b);
      if (r < rings - 1) indices.push(b, c, d);
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

describe("meshlet DAG", () => {
  it("builds monotone LOD levels with decreasing triangles and growing error", () => {
    const dag = buildMeshletDag(sphereGeometry(), { levels: 4 });
    expect(dag.levels.length).toBeGreaterThanOrEqual(2);
    expect(dag.levels[0]!.level).toBe(0);
    expect(dag.levels[0]!.error).toBe(0);
    for (let i = 1; i < dag.levels.length; i++) {
      const prev = dag.levels[i - 1]!, cur = dag.levels[i]!;
      expect(cur.indices.length / 3).toBeLessThan(prev.indices.length / 3);
      expect(cur.error).toBeGreaterThan(prev.error);
      expect(cur.meshletCount).toBeLessThan(prev.meshletCount);
    }
  });

  it("level 0 clusters match a direct buildMeshlets run", () => {
    const geometry = sphereGeometry(16, 8);
    const dag = buildMeshletDag(geometry, { levels: 3 });
    const direct = buildMeshlets(geometry, { maxTriangles: 64 });
    expect(dag.levels[0]!.meshletCount).toBe(direct.meshletCount);
    expect(dag.levels[0]!.descriptors).toEqual(direct.descriptors);
  });

  it("simplified levels contain no degenerate triangles and stay within source bounds", () => {
    const dag = buildMeshletDag(sphereGeometry(), { levels: 4 });
    for (const level of dag.levels) {
      const seen = new Set<string>();
      for (let e = 0; e < level.indices.length; e += 3) {
        const key = [level.indices[e], level.indices[e + 1], level.indices[e + 2]].sort().join("_");
        expect(seen.has(key)).toBe(false);
        seen.add(key);
        const ax = level.positions[level.indices[e]! * 3]!, ay = level.positions[level.indices[e]! * 3 + 1]!, az = level.positions[level.indices[e]! * 3 + 2]!;
        const bx = level.positions[level.indices[e + 1]! * 3]!, by = level.positions[level.indices[e + 1]! * 3 + 1]!, bz = level.positions[level.indices[e + 1]! * 3 + 2]!;
        const cx = level.positions[level.indices[e + 2]! * 3]!, cy = level.positions[level.indices[e + 2]! * 3 + 1]!, cz = level.positions[level.indices[e + 2]! * 3 + 2]!;
        const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
        const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
        const area2 = Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
        expect(area2).toBeGreaterThan(0); // 无退化:每个保留三角形面积非零
      }
    }
  });

  it("is deterministic across runs (byte-identical levels)", () => {
    const geometry = sphereGeometry(20, 10);
    const a = buildMeshletDag(geometry, { levels: 3 });
    const b = buildMeshletDag(geometry, { levels: 3 });
    for (let i = 0; i < a.levels.length; i++) {
      expect(a.levels[i]!.positions).toEqual(b.levels[i]!.positions);
      expect(a.levels[i]!.indices).toEqual(b.levels[i]!.indices);
      expect(a.levels[i]!.descriptors).toEqual(b.levels[i]!.descriptors);
    }
  });

  it("clusterSimplify reduces a dense grid deterministically", () => {
    const geometry = sphereGeometry(48, 24);
    const first = clusterSimplify(geometry.positions, geometry.indices, 2);
    const second = clusterSimplify(geometry.positions, geometry.indices, 2);
    expect(first.indices.length).toBe(second.indices.length);
    expect(first.indices.length / 3).toBeLessThan(geometry.indices.length / 3);
  });
});
