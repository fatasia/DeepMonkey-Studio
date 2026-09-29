/**
 * B4/HLOD 合批绘制计划单元测试:几何合同、矩阵等价性、脏行 delta、
 * 绘制账目、计时身份登记(J4 原子对)。纯 CPU,mocked GPU 不涉及。
 */

import { describe, expect, it } from "vitest";
import type { GeometryResource } from "../renderPacket.js";
import type { HlodClusterFramePlan,
  HlodClusterProxyDraw } from "../threeBridge/hlodClusterStream.js";
import { composeAffineColumnMajor, composeProxyInstanceMatrix, hlodProxyBatchInstances,
  hlodProxyBoxExtents, hlodProxyDrawCost, HLOD_PROXY_UNIT_GEOMETRY_ID,
  hlodProxyUnitBoxGeometry, HlodProxyDrawBatcher, PER_PROXY_BATCH_ROW_BYTES } from "./hlodProxyDrawBatch.js";
import { HLOD_PROXY_CAPABILITY_ID, HLOD_PROXY_TIMED_PASS_ID,
  HLOD_PROXY_TIMING_STAGE, hlodProxyTimedPassRegistration } from "./hlodProxyTimedPass.js";
import { isPbrPassTimingStage, pbrPassTimingStage, PBR_TIMED_PASS_IDS } from "./pbrTimedPassIds.js";
import { PBR_RENDERER_CAPABILITY_SELF_CHECK } from "./rendererCapabilitySelfCheck.js";

// 材质合同值由 threeBridge 单源持有(纯净化层级:webgpu 侧不值导入);此处用同值字面量
// 驱动合批器,跨层等价性由 threeBridge 侧 batchBench 测试钉住。
const OVERLAY_MATERIAL_ID = "hlod-proxy-cluster";

function boxGeometry(id: string, min: readonly [number, number, number],
  max: readonly [number, number, number]): GeometryResource {
  const vertices = new Float32Array(24 * 6);
  const indices = new Uint32Array(36);
  const corners: readonly [number, number, number][] = [
    [min[0], min[1], min[2]], [max[0], min[1], min[2]], [max[0], max[1], min[2]], [min[0], max[1], min[2]],
    [min[0], min[1], max[2]], [max[0], min[1], max[2]], [max[0], max[1], max[2]], [min[0], max[1], max[2]],
  ];
  const faces: readonly { readonly normal: readonly [number, number, number];
    readonly quad: readonly [number, number, number, number] }[] = [
    { normal: [1, 0, 0], quad: [1, 2, 6, 5] }, { normal: [-1, 0, 0], quad: [0, 4, 7, 3] },
    { normal: [0, 1, 0], quad: [3, 7, 6, 2] }, { normal: [0, -1, 0], quad: [0, 1, 5, 4] },
    { normal: [0, 0, 1], quad: [4, 5, 6, 7] }, { normal: [0, 0, -1], quad: [0, 3, 2, 1] },
  ];
  faces.forEach((face, faceIndex) => {
    const base = faceIndex * 4;
    for (let corner = 0; corner < 4; corner++) {
      const offset = (base + corner) * 6;
      const point = corners[face.quad[corner]!]!;
      vertices[offset] = point[0]; vertices[offset + 1] = point[1]; vertices[offset + 2] = point[2];
      vertices[offset + 3] = face.normal[0]; vertices[offset + 4] = face.normal[1]; vertices[offset + 5] = face.normal[2];
    }
    const indexBase = faceIndex * 6;
    indices[indexBase] = base; indices[indexBase + 1] = base + 1; indices[indexBase + 2] = base + 2;
    indices[indexBase + 3] = base; indices[indexBase + 4] = base + 2; indices[indexBase + 5] = base + 3;
  });
  return { id, revision: 0, vertices, indices };
}

function planOf(draws: readonly HlodClusterProxyDraw[], origin: readonly [number, number, number] = [0, 0, 0],
  hidden: readonly string[] = []): HlodClusterFramePlan {
  return { origin, hiddenInstanceIds: new Set(hidden),
    activeProxyDraws: new Map(draws.map(draw => [draw.instanceId, draw])),
    collapsedNodeCount: draws.length, suppressed: false };
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const TRANSLATED = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1];
const UNIT = hlodProxyUnitBoxGeometry();

describe("HLOD 单元盒几何合同", () => {
  it("顶点/索引数、角点范围与外法线符合 stride-6 盒约定", () => {
    expect(UNIT.vertices.length).toBe(24 * 6);
    expect(UNIT.indices.length).toBe(36);
    for (let offset = 0; offset < UNIT.vertices.length; offset += 6) {
      for (let axis = 0; axis < 3; axis++) {
        expect(Math.abs(UNIT.vertices[offset + axis]!)).toBeLessThanOrEqual(0.5);
      }
      // 外法线与位置的点积恒为 0.5(面在 ±0.5,法线朝外)。
      const dot = UNIT.vertices[offset]! * UNIT.vertices[offset + 3]!
        + UNIT.vertices[offset + 1]! * UNIT.vertices[offset + 4]!
        + UNIT.vertices[offset + 2]! * UNIT.vertices[offset + 5]!;
      expect(dot).toBeCloseTo(0.5, 12);
    }
    for (const index of UNIT.indices) expect(index).toBeLessThan(24);
  });

  it("每面第一个三角形从外看 CCW(叉积与法线同向)", () => {
    for (let faceIndex = 0; faceIndex < 6; faceIndex++) {
      const base = faceIndex * 4;
      const at = (vertex: number, component: number) => UNIT.vertices[(base + vertex) * 6 + component]!;
      const edge1 = [at(1, 0) - at(0, 0), at(1, 1) - at(0, 1), at(1, 2) - at(0, 2)];
      const edge2 = [at(2, 0) - at(0, 0), at(2, 1) - at(0, 1), at(2, 2) - at(0, 2)];
      const cross = [edge1[1]! * edge2[2]! - edge1[2]! * edge2[1]!,
        edge1[2]! * edge2[0]! - edge1[0]! * edge2[2]!, edge1[0]! * edge2[1]! - edge1[1]! * edge2[0]!];
      const normal = [at(0, 3), at(0, 4), at(0, 5)];
      expect(cross[0]! * normal[0]! + cross[1]! * normal[1]! + cross[2]! * normal[2]!).toBeGreaterThan(0);
    }
  });

  it("盒几何 min/max 摘要给出精确的中心与半边长;非法几何 fail-closed", () => {
    const geometry = boxGeometry("px-a", [-1, -2, -3], [3, 2, 1]);
    expect(hlodProxyBoxExtents(geometry)).toEqual({ center: [1, 0, -1], half: [2, 2, 2] });
    expect(() => hlodProxyBoxExtents(
      { id: "px-bad", revision: 0, vertices: new Float32Array([0, 0, 0]), indices: new Uint32Array(3) }))
      .toThrow(/stride-6/);
    expect(() => hlodProxyBoxExtents(
      { id: "px-empty", revision: 0, vertices: new Float32Array(0), indices: new Uint32Array(0) }))
      .toThrow(/stride-6/);
  });
});

describe("实例矩阵合成", () => {
  it("恒等放置下单元盒角点精确映到代理盒角点", () => {
    const extents = { center: [1, 0, -1] as const, half: [2, 2, 2] as const };
    const matrix = composeProxyInstanceMatrix(IDENTITY, extents);
    const apply = (point: readonly number[]) => [
      matrix[0]! * point[0]! + matrix[4]! * point[1]! + matrix[8]! * point[2]! + matrix[12]!,
      matrix[1]! * point[0]! + matrix[5]! * point[1]! + matrix[9]! * point[2]! + matrix[13]!,
      matrix[2]! * point[0]! + matrix[6]! * point[1]! + matrix[10]! * point[2]! + matrix[14]!];
    expect(apply([-0.5, -0.5, -0.5])).toEqual([-1, -2, -3]);
    expect(apply([0.5, 0.5, 0.5])).toEqual([3, 2, 1]);
  });

  it("放置变换前乘盒矩阵:T·M_box 与手算复合逐位一致", () => {
    const extents = { center: [1, 2, 3] as const, half: [1, 1, 1] as const };
    const boxMatrix = new Float32Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1]);
    const composed = composeProxyInstanceMatrix(TRANSLATED, extents);
    const expected = composeAffineColumnMajor(TRANSLATED, boxMatrix);
    expect([...composed]).toEqual([...expected]);
    // 平移放置把盒中心平移 (5,6,7)。
    expect(composed[12]).toBe(6);
    expect(composed[13]).toBe(8);
    expect(composed[14]).toBe(10);
  });

  it("仿射乘积:恒等消去与平移叠加符合列主序合同;非法变换 fail-closed", () => {
    expect([...composeAffineColumnMajor(IDENTITY, TRANSLATED)]).toEqual(TRANSLATED);
    expect([...composeAffineColumnMajor(TRANSLATED, IDENTITY)]).toEqual(TRANSLATED);
    expect(() => composeProxyInstanceMatrix([1, 0, 0, 0], { center: [0, 0, 0], half: [1, 1, 1] }))
      .toThrow(/4x4/);
    expect(() => composeProxyInstanceMatrix(
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, Number.NaN, 0, 0, 1], { center: [0, 0, 0], half: [1, 1, 1] }))
      .toThrow(/4x4/);
  });
});

describe("合批器 delta 与缓存", () => {
  const geometryA = boxGeometry("hlod-proxy-a", [0, 0, 0], [2, 2, 2]);
  const geometryB = boxGeometry("hlod-proxy-b", [10, 0, 0], [12, 4, 2]);
  const geometries = new Map([geometryA, geometryB].map(geometry => [geometry.id, geometry]));
  const drawsA: HlodClusterProxyDraw[] = [
    { instanceId: "px-1", geometryId: "hlod-proxy-a", transform: [...IDENTITY] },
    { instanceId: "px-2", geometryId: "hlod-proxy-b", transform: [...TRANSLATED] }];

  it("活动集按 id 升序编行,矩阵与逐代理合成一致;缺失几何 fail-closed", () => {
    const batcher = new HlodProxyDrawBatcher({ materialId: OVERLAY_MATERIAL_ID });
    const update = batcher.update(planOf(drawsA), geometries);
    expect(update.fullRebuild).toBe(true);
    expect(update.plan.instanceIds).toEqual(["px-1", "px-2"]);
    expect(update.plan.instanceCount).toBe(2);
    expect(update.plan.geometryId).toBe(HLOD_PROXY_UNIT_GEOMETRY_ID);
    expect(update.plan.materialId).toBe(OVERLAY_MATERIAL_ID);
    expect([...update.plan.matrices.slice(0, 16)])
      .toEqual([...composeProxyInstanceMatrix(IDENTITY, hlodProxyBoxExtents(geometryA))]);
    expect([...update.plan.matrices.slice(16, 32)])
      .toEqual([...composeProxyInstanceMatrix(TRANSLATED, hlodProxyBoxExtents(geometryB))]);
    expect(() => batcher.update(planOf([{ instanceId: "px-x", geometryId: "hlod-missing",
      transform: [...IDENTITY] }]), geometries)).toThrow(/hlod-missing/);
  });

  it("同签名 no-op 帧零脏行;活动集变化全量重编;原点变化视为签名变化", () => {
    const batcher = new HlodProxyDrawBatcher({ materialId: OVERLAY_MATERIAL_ID });
    batcher.update(planOf(drawsA), geometries);
    const steady = batcher.update(planOf(drawsA), geometries);
    expect(steady.fullRebuild).toBe(false);
    expect(steady.changedRows).toEqual([]);
    const moved = batcher.update(planOf(drawsA, [10, 0, 0]), geometries);
    expect(moved.fullRebuild).toBe(true);
    expect(moved.changedRows).toEqual([0, 1]);
    const grown = batcher.update(planOf([...drawsA, { instanceId: "px-3",
      geometryId: "hlod-proxy-a", transform: [...IDENTITY] }]), geometries);
    expect(grown.plan.instanceCount).toBe(3);
    expect(grown.changedRows).toEqual([0, 1, 2]);
  });

  it("盒几何按 id 缓存复用;同 id revision 漂移 fail-closed(内容寻址合同)", () => {
    const batcher = new HlodProxyDrawBatcher({ materialId: OVERLAY_MATERIAL_ID });
    batcher.update(planOf(drawsA), geometries);
    expect(batcher.cachedGeometryCount).toBe(2);
    batcher.update(planOf(drawsA), geometries);
    expect(batcher.cachedGeometryCount).toBe(2);
    const drifted = new Map(geometries);
    drifted.set("hlod-proxy-a", { ...geometryA, revision: 1 });
    expect(() => batcher.update(planOf(drawsA), drifted)).toThrow(/revision drifted/);
  });

  it("抑制帧(空活动集)产出零实例计划;实例行引用共享单元盒几何", () => {
    const batcher = new HlodProxyDrawBatcher({ materialId: OVERLAY_MATERIAL_ID });
    const suppressed = batcher.update(planOf([]), geometries);
    expect(suppressed.plan.instanceCount).toBe(0);
    expect(suppressed.plan.matrices.length).toBe(0);
    expect(suppressed.changedRows).toEqual([]);
    const restored = batcher.update(planOf(drawsA), geometries);
    const rows = hlodProxyBatchInstances(restored.plan);
    expect(rows.map(row => row.id)).toEqual(["px-1", "px-2"]);
    expect(rows.every(row => row.geometry === HLOD_PROXY_UNIT_GEOMETRY_ID
      && row.material === OVERLAY_MATERIAL_ID && row.transform.length === 16)).toBe(true);
  });
});

describe("绘制账目与逐 pass 计时登记", () => {
  it("242 代理(T00 10k 远档量级)的账目:1 draw、激活/稳态/重编字节按合同计", () => {
    const cost = hlodProxyDrawCost(242, 720);
    expect(cost.perProxyDraws).toBe(242);
    expect(cost.batchedDraws).toBe(1);
    expect(cost.drawReduction).toBeCloseTo(1 - 1 / 242, 12);
    expect(cost.perProxyActivationBytes).toBe(242 * (720 + PER_PROXY_BATCH_ROW_BYTES));
    expect(cost.batchedActivationBytes).toBe(720 + 242 * 64);
    expect(cost.perProxySteadyFrameBytes).toBe(242 * PER_PROXY_BATCH_ROW_BYTES);
    expect(cost.batchedSteadyFrameBytes).toBe(0);
    const partial = hlodProxyDrawCost(242, 720, 3);
    expect(partial.batchedDeltaFrameBytes).toBe(3 * 64);
    expect(partial.perProxyDeltaFrameBytes).toBe(242 * PER_PROXY_BATCH_ROW_BYTES);
    expect(() => hlodProxyDrawCost(-1, 720)).toThrow(TypeError);
    expect(() => hlodProxyDrawCost(2.5, 720)).toThrow(TypeError);
    expect(() => hlodProxyDrawCost(10, 720, 11)).toThrow(TypeError);
  });

  it("hlod-proxy 为暂缓登记:冻结清单保持原 15 项,阶段键在登记前被 telemetry 拒绝", () => {
    expect(HLOD_PROXY_TIMED_PASS_ID).toBe("hlod-proxy");
    // 冻结钉:既有 pass id 清单逐项不变(其他智能体在用,禁止重排/改名)。
    expect([...PBR_TIMED_PASS_IDS]).toEqual([
      "contact-shadow", "contact-apply", "opaque", "ambient-occlusion", "apply-ambient-occlusion",
      "transparent-oit", "composite-oit", "volumetric-fog-march", "volumetric-fog-composite",
      "screen-space-reflection-trace", "screen-space-reflection-composite", "temporal-aa",
      "temporal-upscale", "bloom", "present"]);
    // 登记合同(见 hlodProxyTimedPass.ts 文件头原子 diff):清单必须与 MAPPED_EXECUTORS
    // 键集合一致,渲染侧尚无 hlod-proxy pass → 追加必须与 pass 落地同切片。
    const registration = hlodProxyTimedPassRegistration();
    expect(registration.registered).toBe(false);
    expect(registration.stageAccepted).toBe(false);
    expect(isPbrPassTimingStage(HLOD_PROXY_TIMING_STAGE)).toBe(false);
    expect(HLOD_PROXY_TIMING_STAGE).toBe("gpu-pass:hlod-proxy");
    expect(HLOD_PROXY_TIMING_STAGE).toBe(pbrPassTimingStage(HLOD_PROXY_TIMED_PASS_ID));
  });

  it("J4 落点存在:cluster-lod 能力行在册且尚未声明 hlod- 计时 pass(与暂缓态一致)", () => {
    const row = PBR_RENDERER_CAPABILITY_SELF_CHECK.find(entry => entry.capabilityId === HLOD_PROXY_CAPABILITY_ID);
    expect(row).toBeDefined();
    expect(row?.support).toBe("supported");
    expect(row?.passIds ?? []).not.toContain(HLOD_PROXY_TIMED_PASS_ID);
  });
});
