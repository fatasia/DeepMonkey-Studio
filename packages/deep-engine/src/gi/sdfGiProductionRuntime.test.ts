// Brief-GI M2 生产接线单测(纯 CPU 面;GPU dispatch 真机证据走 lab 探针):
// - 场景适配:包快照 → 烘焙实例(动态/BLEND 排除、变换转置、解交错);
// - 预算窗口:ddgiUpdateBudget 同族分摊(确定性轮转);
// - 参数打包:48B 两份 uniform 与 WGSL struct 布局互钉;
// - 记录初值:96B ABI + 有界 Chebyshev 先验;
// - 计时登记暂存:原子 diff 未落地前 registered=false 且帧计划无 sdf-gi pass。
import { describe, expect, it } from "vitest";
import { bakeSdfSceneGrid } from "./sdfSceneBake.js";
import { traceSdfSkyVisibility } from "./sdfSkyVisibility.js";
import { deriveSdfGiProbeLattice, sdfGiBakeInstancesFromPackets, unpackTransformRow,
  type SdfGiPacketSnapshot } from "./sdfGiSceneAdapter.js";
import { packInitialSdfGiRecords, packSdfGiDirectionTable, packSdfGiProbePositions,
  packSdfGiProbeUpdateParams, packSdfGiSkyRadianceTable, packSdfGiSkyTraceParams,
  planSdfGiProbeWindow, sdfGiTimedPassRegistration, SDF_GI_TIMED_PASS_IDS } from "./sdfGiPacking.js";
import { PBR_TIMED_PASS_IDS } from "../webgpu/pbrTimedPassIds.js";
import { buildPbrFrameExecutionPlan } from "../webgpu/pbrFramePlanExecutor.js";
import { resolvePbrRendererFeatures } from "../webgpu/pbrRendererFeatures.js";

/** 12 三角形 AABB 盒 mesh(与 sdfGiDayNight.aabbBoxMesh 同构)。 */
function boxMesh(min: readonly number[], max: readonly number[]): {
  positions: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> } {
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    return {
      positions: Float32Array.from([
        x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
        x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
      ]),
      indices: Uint32Array.from([
        0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
        3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
      ]),
    };
}

/** xyz+法线交错顶点(GeometryResource.vertices 布局):纯 xyz + 零法线。 */
function interleaved(positions: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> {
  const count = positions.length / 3;
  const out = new Float32Array(count * 6);
  for (let vertex = 0; vertex < count; vertex++) {
    out.set([positions[vertex * 3]!, positions[vertex * 3 + 1]!, positions[vertex * 3 + 2]!, 0, 0, 1],
      vertex * 6);
  }
  return out;
}

/** packed 实例行(36 float):变换段 = 列主 3×4,其余零。 */
function packedRow(basis: readonly number[], translation: readonly number[]): Float32Array<ArrayBuffer> {
  // basis 以行主输入 → packed 列主(列j = basis 第 j 列)。
  const row = new Float32Array(36);
  row[0] = basis[0]!; row[1] = basis[3]!; row[2] = basis[6]!;
  row[3] = basis[1]!; row[4] = basis[4]!; row[5] = basis[7]!;
  row[6] = basis[2]!; row[7] = basis[5]!; row[8] = basis[8]!;
  row[9] = translation[0]!; row[10] = translation[1]!; row[11] = translation[2]!;
  return row;
}

describe("Brief-GI M2 scene adapter", () => {
  it("maps static opaque batches to bake instances and excludes deformable/blend ones", () => {
    const mesh = boxMesh([0, 0, 0], [1, 1, 1]);
    const geometry = {
      id: "g-box", revision: 1, vertices: interleaved(mesh.positions), indices: mesh.indices,
    };
    const batch = (overrides: {}): never => overrides as never;
    const snapshot: SdfGiPacketSnapshot = {
      geometries: new Map([["g-box", { source: geometry }]]),
      batches: new Map([
        ["static", batch({ source: { key: "static", geometry: "g-box", count: 2,
          data: concatRows(packedRow([1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0]),
            packedRow([2, 0, 0, 0, 1, 0, 0, 0, 1], [5, 0, 0])), alphaMode: "OPAQUE" } })],
        ["deform", batch({ source: { key: "deform", geometry: "g-box", count: 1,
          data: packedRow([1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0]), alphaMode: "OPAQUE",
          pose: "pose-1" } })],
        ["glass", batch({ source: { key: "glass", geometry: "g-box", count: 1,
          data: packedRow([1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0]), alphaMode: "BLEND" } })],
      ]),
    };
    const instances = sdfGiBakeInstancesFromPackets(snapshot);
    expect(instances).toHaveLength(2);
    // 变换转置:第二实例 basis = X×2 缩放,平移 (5,0,0) —— 世界 AABB 相应放大平移。
    expect(instances[1]!.transform?.basis).toEqual([2, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(instances[1]!.transform?.translation).toEqual([5, 0, 0]);
  });

  it("unpackTransformRow transposes the packed column-major row to a row-major basis", () => {
    const row = packedRow([1, 2, 3, 0, 1, 0, 0, 0, 1], [7, 8, 9]);
    const transform = unpackTransformRow(row, 0);
    expect(transform.basis).toEqual([1, 2, 3, 0, 1, 0, 0, 0, 1]);
    expect(transform.translation).toEqual([7, 8, 9]);
  });

  it("adapting then baking yields a field the CPU sky trace can occlude with", () => {
    const mesh = boxMesh([0, 0, 0], [4, 2, 4]);
    const geometry = { id: "g", revision: 1, vertices: interleaved(mesh.positions), indices: mesh.indices };
    const snapshot: SdfGiPacketSnapshot = {
      geometries: new Map([["g", { source: geometry }]]),
      batches: new Map([["b", { source: { key: "b", geometry: "g", count: 1,
        data: packedRow([1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0]), alphaMode: "OPAQUE" } } as never]]),
    };
    const instances = sdfGiBakeInstancesFromPackets(snapshot);
    // 显式 bounds 含探针域(y 到 3.5):域外探针走 fail-open=1,测不到遮蔽。
    const { grid } = bakeSdfSceneGrid(instances, { cellSize: 0.25, instanceDomain: "scene",
      bounds: { min: [-0.5, -0.5, -0.5], max: [4.5, 3.5, 4.5] } });
    const probes: [number, number, number][] = [[2, 3, 2]];
    const directions: [number, number, number][] = [[0, 1, 0], [0, -1, 0]];
    const visibility = traceSdfSkyVisibility(grid, probes, directions, {});
    expect(visibility[0]).toBeGreaterThan(0.5);
    expect(visibility[1]!).toBeLessThan(0.5);
  });
});

describe("Brief-GI M2 probe update window (ddgiUpdateBudget 同族)", () => {
  it("amortizes probes deterministically and wraps by modulo", () => {
    expect(planSdfGiProbeWindow(0, 64, 0)).toEqual({ offset: 0, count: 0 });
    expect(planSdfGiProbeWindow(252, 0, 3)).toEqual({ offset: 0, count: 0 });
    expect(planSdfGiProbeWindow(252, 64, 0)).toEqual({ offset: 0, count: 64 });
    expect(planSdfGiProbeWindow(252, 64, 1)).toEqual({ offset: 64, count: 64 });
    expect(planSdfGiProbeWindow(252, 64, 3)).toEqual({ offset: 192, count: 60 });
    // 预算 ≥ 探针数 = 全量,offset 恒 0:
    expect(planSdfGiProbeWindow(16, 64, 7)).toEqual({ offset: 0, count: 16 });
  });

  it("packs the 48B update/trace uniforms in the WGSL struct layout", () => {
    const update = new DataView(packSdfGiProbeUpdateParams({ probeCount: 252, directionCount: 16,
      windowOffset: 7, windowCount: 64, alpha: 0.1, maxDistance: 10, bounceAlbedo: [0.5, 0.4, 0.3] }));
    // GI-FIN:uniform 扩到 64B(bounceAlbedo vec4 后追加 maxDistance)。
    expect(update.byteLength).toBe(64);
    expect(update.getUint32(0, true)).toBe(252);
    expect(update.getUint32(4, true)).toBe(16);
    expect(update.getUint32(8, true)).toBe(7);
    expect(update.getUint32(12, true)).toBe(64);
    expect(update.getFloat32(16, true)).toBeCloseTo(0.1);
    expect(update.getUint32(20, true)).toBe(1);
    expect(update.getUint32(24, true)).toBe(6);
    expect(update.getFloat32(28, true)).toBeCloseTo(2.01);
    expect(update.getFloat32(32, true)).toBeCloseTo(0.5);
    expect(update.getFloat32(36, true)).toBeCloseTo(0.4);
    expect(update.getFloat32(40, true)).toBeCloseTo(0.3);
    // 无 bounce:开关 0,albedo 槽零填充:
    const plain = new DataView(packSdfGiProbeUpdateParams({ probeCount: 1, directionCount: 16,
      windowOffset: 0, windowCount: 1, alpha: 0.1, maxDistance: 10 }));
    expect(plain.getUint32(20, true)).toBe(0);
    expect(plain.getFloat32(32, true)).toBe(0);
        expect(plain.getFloat32(48, true)).toBe(10); // maxDistance(必填,不再是可选槽)
    expect(plain.getFloat32(44, true)).toBe(0); // albedo.w 对齐保留

    const trace = new DataView(packSdfGiSkyTraceParams({ origin: [1, 2, 3], cellSize: 0.25,
      dimensions: [32, 16, 24], steps: 8, coneTan: 0.268, maxDistance: 10,
      directionCount: 16, probeCount: 252 }));
    expect(trace.byteLength).toBe(48);
    expect(trace.getFloat32(0, true)).toBeCloseTo(1);
    expect(trace.getFloat32(12, true)).toBeCloseTo(0.25);
    expect(trace.getUint32(16, true)).toBe(32);
    expect(trace.getUint32(28, true)).toBe(8);
    expect(trace.getUint32(40, true)).toBe(16);
    expect(trace.getUint32(44, true)).toBe(252);
  });

  it("packs direction/position/radiance tables and bounded initial records", () => {
    const directions = packSdfGiDirectionTable(16);
    expect(directions.length).toBe(64);
    // 单位向量(w 槽零):
    for (let direction = 0; direction < 16; direction++) {
      const [x, y, z, w] = [...directions.slice(direction * 4, direction * 4 + 4)];
      expect(Math.hypot(x!, y!, z!)).toBeCloseTo(1, 5);
      expect(w).toBe(0);
    }
    expect(packSdfGiProbePositions([[1, 2, 3], [4, 5, 6]]).length).toBe(8);
    const radiance = packSdfGiSkyRadianceTable(16, [1, 0.5, 0.25]);
    expect(radiance[0]).toBe(1);
    expect(radiance[1]).toBe(0.5);
    expect(radiance[3]).toBe(0);

    const records = packInitialSdfGiRecords(4, 10);
    expect(records.length).toBe(4 * 6 * 4);
    // validity 1 / irradiance 0 / meanDistance = max/2 / variance = (max/4)²:
    for (let probe = 0; probe < 4; probe++) {
      const base = probe * 24;
      expect(records[base + 3]).toBe(1);
      expect(records[base + 4]).toBeCloseTo(5);
      expect(records[base + 5]).toBeCloseTo(6.25);
      // F5 words 全零(SH 缺失语义):
      for (let word = 12; word < 24; word++) expect(records[base + word]).toBe(0);
    }
  });
});

describe("Brief-GI M2 timed-pass registration (原子 diff 暂存) + frame plan", () => {
  it("reports the GI-FIN timed-pass registration as landed, with no pass-plan drift", () => {
    const registration = sdfGiTimedPassRegistration();
    // GI-FIN:登记落地(pbrTimedPassIds 追加两 pass + 帧图 pass + MAPPED_EXECUTORS
    // 三文件原子 diff),marker 开始括夹;stage 透传 registered。
    expect(registration.registered).toBe(true);
    expect(registration.stageAccepted).toBe(true);
    for (const passId of SDF_GI_TIMED_PASS_IDS) {
      expect(PBR_TIMED_PASS_IDS).toContain(passId);
    }
    // 开关关(默认):帧执行计划与既有逐位一致,无 sdf-gi pass;开关开也不加计划 pass
    // (dispatch 走主 encoder 直编,登记随帧图切片落地)。
    const surface = { width: 1920, height: 1080 };
    const off = buildPbrFrameExecutionPlan(surface,
      { transparency: true, features: resolvePbrRendererFeatures({}) });
    const on = buildPbrFrameExecutionPlan(surface,
      { transparency: true, features: resolvePbrRendererFeatures({ sdfGi: true }) });
    // GI-FIN:帧图分支已登记 —— 开关改变帧图(两 compute pass 进 plan),
    // planHash 随之不同是正确语义;关=既有帧逐位一致由「off 不含 sdf-gi pass」断言。
    expect(off.planHash).not.toBe(on.planHash);
    expect(off.passOrder).not.toEqual(on.passOrder);
    expect(on.passOrder.filter(id => id.startsWith("sdf-gi-"))).toEqual(["sdf-gi-sky-trace", "sdf-gi-probe-update"]);
    for (const passId of SDF_GI_TIMED_PASS_IDS) {
      expect(off.passOrder).not.toContain(passId);
    }
  });
});

function concatRows(...rows: Float32Array<ArrayBuffer>[]): Float32Array<ArrayBuffer> {
  const out = new Float32Array(rows.reduce((total, row) => total + row.length, 0));
  let cursor = 0;
  for (const row of rows) { out.set(row, cursor); cursor += row.length; }
  return out;
}
