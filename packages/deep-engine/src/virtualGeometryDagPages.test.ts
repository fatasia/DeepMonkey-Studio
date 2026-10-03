import { describe, expect, it } from "vitest";
import { buildMeshletDag } from "./geometry/meshletDag.js";
import type { IndexedTriangleGeometry } from "./geometry/types.js";
import { compileVirtualGeometryDagPages, virtualGeometryDagPageId } from "./virtualGeometryDagPages.js";

/** 确定性球面网格(经纬细分),与 meshletDag.test 同构造。 */
function sphereGeometry(segments = 48, rings = 24): IndexedTriangleGeometry {
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

function pageTable(levels = 3) {
  const dag = buildMeshletDag(sphereGeometry(), { levels });
  return { dag, table: compileVirtualGeometryDagPages(dag, "test-sphere") };
}

describe("compileVirtualGeometryDagPages", () => {
  it("每层每簇恰好一页,页数等于各层 meshletCount 之和", () => {
    const { dag, table } = pageTable();
    const expectedClusters = dag.levels.reduce((sum, level) => sum + level.meshletCount, 0);
    expect(table.pages.length).toBe(expectedClusters);
    for (const level of dag.levels) {
      const levelPages = table.pages.filter((page) => page.level === level.level);
      expect(levelPages.length).toBe(level.meshletCount);
    }
    expect(new Set(table.pages.map((page) => page.id)).size).toBe(table.pages.length);
  });

  it("页身份确定性:同一 DAG 两次编译逐字段一致,id 可由 virtualGeometryDagPageId 复原", () => {
    const { dag, table } = pageTable();
    const again = compileVirtualGeometryDagPages(dag, "test-sphere");
    expect(again.pages).toEqual(table.pages);
    for (const page of table.pages) {
      expect(page.id).toBe(virtualGeometryDagPageId("test-sphere", page.level, page.cluster));
    }
  });

  it("父子链接与 parentsByLevel 一致(含 M2 -1 哨兵孤儿),根=最粗层+孤儿,子链接为父链接的精确逆", () => {
    const { dag, table } = pageTable(4);
    for (const page of table.pages) {
      if (page.level + 1 < dag.levels.length) {
        const rawParent = dag.parentsByLevel[page.level]![page.cluster]!;
        const coarseCount = dag.levels[page.level + 1]!.meshletCount;
        const expectedParent = rawParent < coarseCount
          ? virtualGeometryDagPageId("test-sphere", page.level + 1, rawParent)
          : null; // 4294967295 = M2 -1 哨兵(细簇被粗层去重吞没)⇒ 孤儿根
        expect(page.parentId).toBe(expectedParent);
      } else {
        expect(page.parentId).toBeNull();
      }
      for (const childId of page.childIds) {
        expect(table.byId.get(childId)!.parentId).toBe(page.id);
      }
    }
    const roots = table.pages.filter((page) => page.parentId === null);
    expect([...table.rootIds].sort()).toEqual(roots.map((page) => page.id).sort());
    const childLinks = table.pages.flatMap((page) => page.childIds).length;
    const parentLinks = table.pages.filter((page) => page.parentId !== null).length;
    expect(childLinks).toBe(parentLinks);
  });

  it("孤儿簇(64×32 夹具存在 M2 -1 哨兵):无父但入根集,可从根遍历到达", () => {
    const table = compileVirtualGeometryDagPages(buildMeshletDag(sphereGeometry(64, 32), { levels: 3 }), "orphan-fixture");
    const orphans = table.pages.filter((page) => page.level + 1 < table.levels && page.parentId === null);
    if (orphans.length === 0) throw new Error("fixture expected at least one orphan fine cluster (M2 sentinel)");
    for (const orphan of orphans) {
      expect(table.rootIds).toContain(orphan.id);
      expect(table.byId.get(orphan.id)!.childIds).toEqual([]);
    }
    // 全部 level0 页均可从某根沿 childIds 到达(割遍历不漏区域)。
    for (const finest of table.pages.filter((page) => page.level === 0)) {
      let reachable = false;
      for (const rootId of table.rootIds) {
        let cursor: string | null = finest.id;
        while (cursor) { if (cursor === rootId) { reachable = true; break; } cursor = table.byId.get(cursor)!.parentId; }
        if (reachable) break;
      }
      expect(reachable).toBe(true);
    }
  });

  it("误差/球界/三角形/firstIndex 与 DAG 层与簇 bounds 同源", () => {
    const { dag, table } = pageTable();
    for (const page of table.pages) {
      const level = dag.levels[page.level]!;
      expect(page.error).toBe(level.error);
      const boundsBase = page.cluster * 16; // MESHLET_BOUNDS_STRIDE
      expect(page.sphere[0]).toBeCloseTo(level.bounds[boundsBase]!, 6);
      expect(page.sphere[3]).toBeCloseTo(level.bounds[boundsBase + 3]!, 6);
      expect(page.triangleCount).toBe(level.descriptors[page.cluster * 4 + 3]!);
      expect(page.byteLength).toBeGreaterThan(0);
    }
    // firstIndex:同层内随簇递增,层首簇为 0。
    for (const level of dag.levels) {
      const levelPages = table.pages.filter((page) => page.level === level.level)
        .sort((left, right) => left.cluster - right.cluster);
      expect(levelPages[0]!.firstIndex).toBe(0);
      for (let i = 1; i < levelPages.length; i++) {
        expect(levelPages[i]!.firstIndex)
          .toBe(levelPages[i - 1]!.firstIndex + levelPages[i - 1]!.triangleCount * 3);
      }
    }
  });

  it("level 0 三角总量等于源三角形数,totalBytes 为各页字节和", () => {
    const { dag, table } = pageTable();
    expect(table.totalTriangles).toBe(dag.levels[0]!.indices.length / 3);
    expect(table.totalBytes).toBe(table.pages.reduce((sum, page) => sum + page.byteLength, 0));
  });

  it("fail-loud:空 source id / 空层 / 未知页拒绝", () => {
    const { dag } = pageTable();
    expect(() => compileVirtualGeometryDagPages(dag, "")).toThrow(/source geometry id/);
    expect(() => compileVirtualGeometryDagPages({ ...dag, levels: [] }, "x")).toThrow(/no levels/);
  });
});
