import { describe, expect, it } from "vitest";
import { buildMeshletDag } from "./geometry/meshletDag.js";
import type { IndexedTriangleGeometry } from "./geometry/types.js";
import type { LodCamera, LodViewport } from "./spatial/index.js";
import { compileVirtualGeometryDagPages, type VirtualGeometryDagPageTable } from "./virtualGeometryDagPages.js";
import { DEEP_VIRTUAL_GEOMETRY_DEFAULT_PIXEL_ERROR, buildVirtualGeometryDagRequests,
  projectedErrorPixels } from "./virtualGeometryScheduling.js";
import { VirtualGeometryDagResidency } from "./virtualGeometryResidency.js";

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

const VIEWPORT: LodViewport = { width: 1920, height: 1080 };
function cameraAt(distance: number): LodCamera {
  return { projection: "perspective", position: [0, 0, distance], forward: [0, 0, -1],
    verticalFovRadians: Math.PI / 3, near: 0.1, far: 100 };
}
function tableFixture(): VirtualGeometryDagPageTable {
  return compileVirtualGeometryDagPages(buildMeshletDag(sphereGeometry(), { levels: 3 }), "fixture");
}
function subtreeIds(table: VirtualGeometryDagPageTable, rootId: string): Set<string> {
  const ids = new Set<string>();
  for (const page of table.pages) {
    let cursor: string | null = page.id;
    while (cursor) { if (cursor === rootId) { ids.add(page.id); break; } cursor = table.byId.get(cursor)!.parentId; }
  }
  return ids;
}

describe("buildVirtualGeometryDagRequests(屏幕误差割)", () => {
  it("远距选最粗层,近距收敛到 level 0;割三角形随逼近单调不减", () => {
    const table = tableFixture();
    const far = buildVirtualGeometryDagRequests(table, cameraAt(1e5), VIEWPORT);
    const near = buildVirtualGeometryDagRequests(table, cameraAt(1.05), VIEWPORT);
    expect(far.drawPageIds.every((id) => table.byId.get(id)!.level === table.levels - 1)).toBe(true);
    expect(near.drawPageIds.every((id) => table.byId.get(id)!.level === 0)).toBe(true);
    const triangles = (ids: readonly string[]) => ids.reduce((sum, id) => sum + table.byId.get(id)!.triangleCount, 0);
    expect(triangles(near.drawPageIds)).toBeGreaterThan(triangles(far.drawPageIds));
    expect(triangles(near.drawPageIds)).toBe(table.totalTriangles);
  });

  it("割性质:绘制页两两无祖先-后代关系,每条根→叶路径恰选一页,祖先全在请求集", () => {
    const table = tableFixture();
    for (const distance of [1.05, 2, 6, 1e5]) {
      const requests = buildVirtualGeometryDagRequests(table, cameraAt(distance), VIEWPORT);
      const selected = new Set(requests.drawPageIds);
      for (const id of requests.drawPageIds) {
        for (let cursor = table.byId.get(id)!.parentId; cursor; cursor = table.byId.get(cursor)!.parentId) {
          expect(selected.has(cursor)).toBe(false); // 反链
          expect(requests.pageIds).toContain(cursor); // 祖先补给
        }
      }
      // 每条根→叶路径(以 level0 页为代表)恰好穿过一个选中页:不漏绘、不重绘。
      for (const finestPage of table.pages.filter((page) => page.level === 0)) {
        let hits = 0;
        for (let cursor: string | null = finestPage.id; cursor; cursor = table.byId.get(cursor)!.parentId) {
          if (selected.has(cursor)) hits += 1;
        }
        expect(hits).toBe(1);
      }
    }
  });

  it("投影单调:同页误差随距离递减;投影比例与 spatial 口径一致(1080p fov60°)", () => {
    const table = tableFixture();
    const page = table.pages.find((candidate) => candidate.error > 0)!;
    const near = projectedErrorPixels(page, cameraAt(2), VIEWPORT);
    const far = projectedErrorPixels(page, cameraAt(8), VIEWPORT);
    expect(near).toBeGreaterThan(far);
    // 合成页钉死公式与 spatial 投影比例:球心在原点、半径 1、误差 0.5,相机距 8。
    const synthetic: VirtualGeometryDagPage = { ...page, sphere: [0, 0, 0, 1], error: 0.5 };
    const scale = 1080 / (2 * Math.tan(Math.PI / 6)); // spatial/lodValidation 透视口径
    expect(projectedErrorPixels(synthetic, cameraAt(8), VIEWPORT)).toBeCloseTo(0.5 * scale / 7, 9);
  });

  it("阈值与视口校验 fail-closed", () => {
    const table = tableFixture();
    expect(() => buildVirtualGeometryDagRequests(table, cameraAt(5), VIEWPORT, { pixelErrorThreshold: 0 }))
      .toThrow(RangeError);
    expect(() => buildVirtualGeometryDagRequests(table, cameraAt(5), { width: 0, height: 1080 })).toThrow(RangeError);
    expect(() => buildVirtualGeometryDagRequests(table,
      { ...cameraAt(5), verticalFovRadians: 0 }, VIEWPORT)).toThrow(RangeError);
    expect(DEEP_VIRTUAL_GEOMETRY_DEFAULT_PIXEL_ERROR).toBe(1);
  });
});

describe("VirtualGeometryDagResidency(驻留与 evict 边界)", () => {
  const pageIdsOf = (table: VirtualGeometryDagPageTable) => table.pages.map((page) => page.id);
  const bytesOf = (table: VirtualGeometryDagPageTable, ids: readonly string[]) =>
    ids.reduce((sum, id) => sum + table.byId.get(id)!.byteLength, 0);

  it("充足预算:全部准入,commit 后可用,驻留字节 ≤ 预算(硬上限不变量)", () => {
    const table = tableFixture();
    const ids = pageIdsOf(table);
    const residency = new VirtualGeometryDagResidency(table, { maxBytes: bytesOf(table, ids) });
    const plan = residency.plan(ids, 0);
    expect(plan.admitted.length).toBe(ids.length);
    expect(plan.deferred).toEqual([]);
    expect(residency.residentByteCount).toBeLessThanOrEqual(bytesOf(table, ids));
    residency.commitAdmissions(plan.admitted.map((handle) => handle.id));
    expect(residency.inflightCount).toBe(0);
    expect(plan.stats.budgetUtilization).toBeLessThanOrEqual(1);
  });

  it("链前缀:细页先行请求被 defer,祖先驻留后放行(父先行流送)", () => {
    const table = tableFixture();
    const residency = new VirtualGeometryDagResidency(table, { maxBytes: table.totalBytes });
    const fine = table.pages.find((page) => page.level === 0 && page.parentId !== null)!;
    const first = residency.plan([fine.id], 0);
    expect(first.deferred).toEqual([fine.id]);
    const ancestors: string[] = [];
    for (let cursor = fine.parentId; cursor; cursor = table.byId.get(cursor)!.parentId) ancestors.push(cursor);
    const second = residency.plan([...ancestors, fine.id], 1);
    expect(second.deferred).toEqual([]);
    expect(second.admitted.map((handle) => handle.id)).toEqual(expect.arrayContaining([fine.id]));
  });

  it("LRU 最久未见:预算挤兑时先逐 lastUsedFrame 更早页;本帧请求页受保护不逐", () => {
    const table = tableFixture();
    const roots = [...table.rootIds].sort();
    const [a, b, c] = roots.map((id) => table.byId.get(id)!);
    const onePageBudget = Math.max(a.byteLength, b.byteLength, c.byteLength);
    const residency = new VirtualGeometryDagResidency(table, { maxBytes: onePageBudget });
    residency.commitAdmissions(residency.plan([a.id], 0).admitted.map((handle) => handle.id));
    residency.commitAdmissions(residency.plan([b.id], 1).admitted.map((handle) => handle.id)); // 逐 a(最久未见)
    expect(residency.plan([b.id], 2).admitted).toEqual([]);
    residency.commitAdmissions(residency.plan([c.id], 3).admitted.map((handle) => handle.id)); // 逐 b
    const residentIds = residency.plan([c.id], 4).resident.map((handle) => handle.id);
    expect(residentIds).toEqual([c.id]);
    // 本帧请求保护:同预算下同时请求两页,先到的页不被逐,后来者 defer。
    const pressure = new VirtualGeometryDagResidency(table, { maxBytes: onePageBudget });
    const both = pressure.plan([a.id, b.id], 0);
    expect(both.admitted.length).toBe(1);
    expect(both.deferred.length).toBe(1);
    expect(pressure.residentCount).toBe(1);
  });

  it("dwell 驻留保护:未满 minResidentFrames 的页不可被压力驱逐", () => {
    const table = tableFixture();
    const roots = [...table.rootIds].sort();
    const [a, b] = roots.map((id) => table.byId.get(id)!);
    const residency = new VirtualGeometryDagResidency(table,
      { maxBytes: Math.max(a.byteLength, b.byteLength), minResidentFrames: 10 });
    residency.commitAdmissions(residency.plan([a.id], 0).admitted.map((handle) => handle.id));
    const early = residency.plan([b.id], 5);
    expect(early.deferred).toEqual([b.id]); // a 在 dwell 内,不可逐 ⇒ b defer
    const late = residency.plan([b.id], 10);
    expect(late.evicted.map((handle) => handle.id)).toEqual([a.id]);
    expect(late.admitted.map((handle) => handle.id)).toEqual([b.id]);
  });

  it("级联驱逐:父页被逐时其驻留后代一并逐出(回退链不断)", () => {
    const table = tableFixture();
    const root = [...table.rootIds].sort()[0]!;
    const child = table.byId.get(root)!.childIds[0]!;
    const other = table.pages.find((page) => page.level === table.levels - 1 && page.id !== root
      && !subtreeIds(table, root).has(page.id))!;
    const residency = new VirtualGeometryDagResidency(table,
      { maxBytes: table.byId.get(root)!.byteLength + table.byId.get(child)!.byteLength });
    residency.commitAdmissions(residency.plan([root, child], 0).admitted.map((handle) => handle.id));
    // child 在 frame1 刷新 lastUsed,root 保持 frame0 ⇒ LRU 先逐 root。
    residency.commitAdmissions(residency.plan([child], 1).admitted.map((handle) => handle.id));
    const swap = residency.plan([other.id], 2);
    const evictedIds = swap.evicted.map((handle) => handle.id).sort();
    expect(evictedIds).toEqual([child, root].sort()); // root 被逐 ⇒ child 级联同逐
    expect(residency.plan([other.id], 3).resident.map((handle) => handle.id)).toEqual([other.id]);
  });

  it("事务:commit 后拒回滚;未知 id 拒绝;先校验后变更(失败不留半状态)", () => {
    const table = tableFixture();
    const residency = new VirtualGeometryDagResidency(table, { maxBytes: table.totalBytes });
    const plan = residency.plan(pageIdsOf(table), 0);
    residency.commitAdmissions(plan.admitted.map((handle) => handle.id));
    expect(() => residency.rollbackAdmissions([plan.admitted[0]!.id]))
      .toThrow(/committed and cannot be rolled back/);
    expect(() => residency.commitAdmissions(["no-such|l0|c0"])).toThrow(/Unknown virtual geometry page/);
    expect(residency.residentCount).toBe(plan.admitted.length);
    const inflight = new VirtualGeometryDagResidency(table, { maxBytes: table.totalBytes });
    const pending = inflight.plan([pageIdsOf(table)[0]!], 0);
    inflight.rollbackAdmissions([pageIdsOf(table)[0]!]);
    expect(inflight.residentCount).toBe(0);
    expect(pending.admitted.length).toBe(1);
  });

  it("提交前缀:已提交页的祖先必须全部已提交(in-flight 粗层不是合法回退)", () => {
    const table = tableFixture();
    const root = [...table.rootIds].sort()[0]!;
    const child = table.byId.get(root)!.childIds[0]!;
    const residency = new VirtualGeometryDagResidency(table, { maxBytes: table.totalBytes });
    residency.plan([root, child], 0);
    expect(() => residency.commitAdmissions([child])).toThrow(/committed-prefix invariant/);
    residency.commitAdmissions([root]);
    expect(() => residency.commitAdmissions([child])).not.toThrow();
  });

  it("冻结相机零抖动:同一请求集重复 plan ⇒ 零准入零驱逐;evictAll 拒 in-flight", () => {
    const table = tableFixture();
    const ids = pageIdsOf(table);
    const residency = new VirtualGeometryDagResidency(table, { maxBytes: table.totalBytes });
    residency.plan(ids, 0);
    for (let frame = 1; frame <= 3; frame++) {
      const steady = residency.plan(ids, frame);
      expect(steady.admitted).toEqual([]);
      expect(steady.evicted).toEqual([]);
      expect(steady.deferred).toEqual([]);
    }
    expect(() => residency.evictAll()).toThrow(/in-flight/);
    residency.commitAdmissions(ids);
    expect(residency.evictAll().length).toBe(ids.length);
    expect(residency.residentCount).toBe(0);
  });
});
