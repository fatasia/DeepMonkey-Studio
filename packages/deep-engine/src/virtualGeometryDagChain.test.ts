import { describe, expect, it } from "vitest";
import { buildMeshletDag } from "./geometry/meshletDag.js";
import type { IndexedTriangleGeometry } from "./geometry/types.js";
import type { LodCamera, LodViewport } from "./spatial/index.js";
import { compileVirtualGeometryDagPages, type VirtualGeometryDagPageTable } from "./virtualGeometryDagPages.js";
import { planVirtualGeometryIndirect } from "./virtualGeometryIndirect.js";
import { buildVirtualGeometryDagRequests, resolveVirtualGeometryDrawablePages } from "./virtualGeometryScheduling.js";
import { VirtualGeometryDagResidency } from "./virtualGeometryResidency.js";

/**
 * Nanite M3 验收①:DAG→页表→驻留→绘制的单元链路。
 * 一个 MeshletDag 进,一份 indirect 命令缓冲出:页表可复原 DAG 层级,驻留只认
 * 预算与 LRU,绘制集 = 割页的最细已驻留祖先(流送中画面不断裂);段间唯一耦合面是页 id。
 */

function sphereGeometry(segments = 64, rings = 32): IndexedTriangleGeometry {
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
    verticalFovRadians: Math.PI / 3, near: 0.1, far: 100000 };
}
function subtreeOf(table: VirtualGeometryDagPageTable, rootId: string): Set<string> {
  const ids = new Set<string>();
  for (const page of table.pages) {
    let cursor: string | null = page.id;
    while (cursor) { if (cursor === rootId) { ids.add(page.id); break; } cursor = table.byId.get(cursor)!.parentId; }
  }
  return ids;
}

/** 帧步进:请求→驻留→提交→绘制集解析→indirect 计划(消费侧完整一帧)。 */
function frame(table: VirtualGeometryDagPageTable, camera: LodCamera, frameIndex: number,
  instanceCount: number, budgetBytes = table.totalBytes) {
  const residency = new VirtualGeometryDagResidency(table, { maxBytes: budgetBytes });
  const requests = buildVirtualGeometryDagRequests(table, camera, VIEWPORT);
  const plan = residency.plan(requests.pageIds, frameIndex);
  residency.commitAdmissions(plan.admitted.map((handle) => handle.id));
  const committed = new Set(plan.admitted.map((handle) => handle.id));
  const drawable = resolveVirtualGeometryDrawablePages(table, requests.drawPageIds, committed);
  const indirect = planVirtualGeometryIndirect(table, drawable, instanceCount);
  return { requests, residency, drawable, indirect, triangles: indirect.stats.triangleCount };
}

describe("DAG→页表→驻留→绘制链路", () => {
  const dag = buildMeshletDag(sphereGeometry(), { levels: 3 });
  const table = compileVirtualGeometryDagPages(dag, "chain-sphere");

  it("近帧:割收敛到 level 0,命令三角形 = 源总量,firstIndex 段拼回整层展开索引", () => {
    const near = frame(table, cameraAt(1.05), 0, 1);
    expect(near.requests.drawPageIds.length).toBe(table.pages.filter((page) => page.level === 0).length);
    expect(near.indirect.stats.drawCount).toBe(near.requests.drawPageIds.length);
    expect(near.triangles).toBe(table.totalTriangles);
    const finest = dag.levels[0]!;
    const covered = near.indirect.groups.filter((group) => group.level === 0)
      .reduce((sum, group) => sum + group.indexCount, 0);
    expect(covered).toBe(finest.indices.length);
  });

  it("档位渐变:由近及远割三角形单调不增;极远收敛到最粗根页(LOD 生效)", () => {
    const level0Pages = table.pages.filter((page) => page.level === 0).length;
    let previous = Number.POSITIVE_INFINITY;
    for (const distance of [1.05, 1.6, 3, 8, 1e3, 1e5]) {
      const step = frame(table, cameraAt(distance), distance, 1);
      expect(step.triangles).toBeLessThanOrEqual(previous);
      expect(step.indirect.stats.drawCount).toBeLessThanOrEqual(level0Pages);
      previous = step.triangles;
    }
    const far = frame(table, cameraAt(1e5), 1e5, 1);
    expect(far.requests.drawPageIds.every((id) => table.byId.get(id)!.level === table.levels - 1)).toBe(true);
    expect(far.triangles).toBeLessThan(table.totalTriangles);
  });

  it("预算挤兑:驻留字节 ≤ 预算,绘制集仍为合法割(每根子树恰一页且反链)", () => {
    const tightBudget = Math.ceil(table.totalBytes / 2);
    const step = frame(table, cameraAt(1.05), 0, 1, tightBudget);
    expect(step.residency.residentByteCount).toBeLessThanOrEqual(tightBudget);
    expect(step.indirect.stats.drawCount).toBeGreaterThan(0);
    const selected = new Set(step.drawable);
    for (const id of step.drawable) {
      for (let cursor = table.byId.get(id)!.parentId; cursor; cursor = table.byId.get(cursor)!.parentId) {
        expect(selected.has(cursor)).toBe(false);
      }
    }
    for (const rootId of table.rootIds) {
      const subtree = subtreeOf(table, rootId);
      expect(step.drawable.filter((id) => subtree.has(id)).length).toBe(1);
    }
  });

  it("流送时序:小预算帧0 粗层全驻留,绘制面由粗层回退顶住不断裂;放大预算后细页接管", () => {
    const residency = new VirtualGeometryDagResidency(table, { maxBytes: Math.ceil(table.totalBytes / 8) });
    const requests = buildVirtualGeometryDagRequests(table, cameraAt(1.05), VIEWPORT);
    const frame0 = residency.plan(requests.pageIds, 0);
    residency.commitAdmissions(frame0.admitted.map((handle) => handle.id));
    const resident0 = new Set(frame0.admitted.map((handle) => handle.id));
    const drawable0 = resolveVirtualGeometryDrawablePages(table, requests.drawPageIds, resident0);
    expect(drawable0.length).toBeGreaterThan(0);
    expect(drawable0.every((id) => table.byId.get(id)!.level >= table.levels - 2)).toBe(true);
    const fullBudget = new VirtualGeometryDagResidency(table, { maxBytes: table.totalBytes });
    const frame1 = fullBudget.plan(requests.pageIds, 1);
    fullBudget.commitAdmissions(frame1.admitted.map((handle) => handle.id));
    const resident1 = new Set(frame1.admitted.map((handle) => handle.id));
    const drawable1 = resolveVirtualGeometryDrawablePages(table, requests.drawPageIds, resident1);
    expect(drawable1).toEqual(requests.drawPageIds);
    const triangles1 = planVirtualGeometryIndirect(table, drawable1, 1).stats.triangleCount;
    expect(triangles1).toBe(table.totalTriangles);
    expect(triangles1).toBeGreaterThan(
      planVirtualGeometryIndirect(table, drawable0, 1).stats.triangleCount);
  });

  it("绘制集解析:割页未驻留时回退最细已驻留祖先;结果仍是反链", () => {
    const rootId = [...table.rootIds].sort()[0]!;
    const mid = table.byId.get(rootId)!.childIds[0]!;
    const fine = table.byId.get(mid)!.childIds[0]!;
    expect(resolveVirtualGeometryDrawablePages(table, [fine], new Set([rootId, mid]))).toEqual([fine]);
    expect(resolveVirtualGeometryDrawablePages(table, [fine], new Set([rootId]))).toEqual([rootId]);
    expect(resolveVirtualGeometryDrawablePages(table, [fine], new Set())).toEqual([]);
    const cut = buildVirtualGeometryDagRequests(table, cameraAt(3), VIEWPORT);
    const drawable = resolveVirtualGeometryDrawablePages(table, cut.drawPageIds, new Set(table.pages.map((page) => page.id)));
    expect(new Set(drawable).size).toBe(drawable.length);
  });

  it("页表是 DAG 的无损投影:层级数与根数一致,根无父", () => {
    expect(table.levels).toBe(dag.levels.length);
    expect(table.rootIds.length).toBe(dag.levels[dag.levels.length - 1]!.meshletCount);
    for (const id of table.rootIds) expect(table.byId.get(id)!.parentId).toBeNull();
  });
});
