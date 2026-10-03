import { describe, expect, it } from "vitest";
import { buildMeshletDag } from "./geometry/meshletDag.js";
import type { IndexedTriangleGeometry } from "./geometry/types.js";
import type { LodCamera, LodViewport } from "./spatial/index.js";
import { compileVirtualGeometryDagPages, type VirtualGeometryDagPageTable } from "./virtualGeometryDagPages.js";
import { DEEP_VIRTUAL_GEOMETRY_INDIRECT_COMMAND_BYTES, DEEP_VIRTUAL_GEOMETRY_INDIRECT_COMMAND_FLOATS,
  encodeVirtualGeometryIndirectCommands, planVirtualGeometryIndirect } from "./virtualGeometryIndirect.js";
import { buildVirtualGeometryDagRequests } from "./virtualGeometryScheduling.js";
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
const CAMERA: LodCamera = { projection: "perspective", position: [0, 0, 2.5], forward: [0, 0, -1],
  verticalFovRadians: Math.PI / 3, near: 0.1, far: 100 };
function tableFixture(): VirtualGeometryDagPageTable {
  return compileVirtualGeometryDagPages(buildMeshletDag(sphereGeometry(), { levels: 3 }), "indirect-fixture");
}
/** 链路夹具:DAG→页表→请求→驻留(提交)→可绘制页集。 */
function residentDrawPages(table: VirtualGeometryDagPageTable) {
  const requests = buildVirtualGeometryDagRequests(table, CAMERA, VIEWPORT);
  const residency = new VirtualGeometryDagResidency(table, { maxBytes: table.totalBytes });
  const plan = residency.plan(requests.pageIds, 0);
  const admittedIds = new Set(plan.admitted.map((handle) => handle.id));
  residency.commitAdmissions([...admittedIds]);
  return requests.drawPageIds.filter((id) => admittedIds.has(id));
}

describe("planVirtualGeometryIndirect(按页分组)", () => {
  it("每驻留绘制页一条命令,5×u32 GPU 布局,firstIndex/indexCount 与页表一致", () => {
    const table = tableFixture();
    const drawable = residentDrawPages(table);
    const plan = planVirtualGeometryIndirect(table, drawable, 7);
    expect(plan.groups.length).toBe(drawable.length);
    expect(plan.commands.length).toBe(drawable.length * DEEP_VIRTUAL_GEOMETRY_INDIRECT_COMMAND_FLOATS);
    expect(plan.stats.commandBytes).toBe(drawable.length * DEEP_VIRTUAL_GEOMETRY_INDIRECT_COMMAND_BYTES);
    plan.groups.forEach((group, index) => {
      const page = table.byId.get(group.pageId)!;
      expect(group.firstIndex).toBe(page.firstIndex);
      expect(group.indexCount).toBe(page.triangleCount * 3);
      const base = index * DEEP_VIRTUAL_GEOMETRY_INDIRECT_COMMAND_FLOATS;
      expect(plan.commands[base]).toBe(page.triangleCount * 3);
      expect(plan.commands[base + 1]).toBe(7);
      expect(plan.commands[base + 2]).toBe(page.firstIndex);
      expect(plan.commands[base + 3]).toBe(0); // baseVertex:展开索引即层内全局顶点号
      expect(plan.commands[base + 4]).toBe(0); // firstInstance:实例缓冲整段,固定 0
    });
    expect(plan.stats.triangleCount).toBe(drawable.reduce((sum, id) => sum + table.byId.get(id)!.triangleCount, 0));
  });

  it("draw 数与实例规模解耦:1 与 200_000 实例命令数不变,仅 instanceCount 字段伸缩", () => {
    const table = tableFixture();
    const drawable = residentDrawPages(table);
    const one = planVirtualGeometryIndirect(table, drawable, 1);
    const mass = planVirtualGeometryIndirect(table, drawable, 200_000);
    expect(one.stats.drawCount).toBe(mass.stats.drawCount);
    expect(one.stats.drawCount).toBe(drawable.length);
    expect(mass.stats.instanceCount).toBe(200_000);
    const base = 0;
    expect(mass.commands[base + 1]).toBe(200_000);
    expect(one.commands[base + 1]).toBe(1);
  });

  it("未驻留页不产生命令;未知页 fail-loud;instanceCount 校验 fail-closed", () => {
    const table = tableFixture();
    expect(planVirtualGeometryIndirect(table, [], 4).stats.drawCount).toBe(0);
    expect(() => planVirtualGeometryIndirect(table, ["ghost|l0|c0"], 1)).toThrow(/unknown page/);
    expect(() => planVirtualGeometryIndirect(table, [], -1)).toThrow(RangeError);
    expect(() => planVirtualGeometryIndirect(table, [], 1.5)).toThrow(RangeError);
  });

  it("命令序确定性:(level, cluster) 升序,重规划逐位一致", () => {
    const table = tableFixture();
    const drawable = residentDrawPages(table);
    const plan = planVirtualGeometryIndirect(table, [...drawable].reverse(), 3);
    const expected = [...plan.groups].map((group) => group.pageId).sort((left, right) => {
      const a = table.byId.get(left)!, b = table.byId.get(right)!;
      return a.level - b.level || a.cluster - b.cluster;
    });
    expect(plan.groups.map((group) => group.pageId)).toEqual(expected);
    expect(plan.commands).toEqual(encodeVirtualGeometryIndirectCommands(plan.groups, 3));
  });
});
