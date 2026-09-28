import { describe, expect, it } from "vitest";
import { buildInstanceVisibilityReference, compareInstanceVisibility, type ReferenceInstance } from "./instanceVisibilityReference.js";
import { buildDepthPyramid, engineTwinBatchKept, type TwinBoundsEntry } from "./instanceVisibilityTwin.js";
import { quadGeometry, scene, twinViewOf, viewProjection, VIEWPORT } from "./instanceVisibilityFixture.js";

/**
 * T05 边界情形矩阵：近裁面穿插 / 负缩放镜像 / 大坐标（UTM）/ 透明物。
 * 每例断言：不崩溃 + 明确语义（参考集与引擎孪生行为可陈述）+ 零错误漏剔。
 * 语义记录：近裁面 fail-open 保留；镜像走支撑项 |Aᵀn|；大坐标 f32 量化由两侧同源吸收；
 * 透明（BLEND）不写遮挡深度且生产上不入剔除相（shadow 候选过滤 + 无 transparent 相剔除编码）。
 */

const SPHERE: readonly [number, number, number, number] = [0, 0, 0, Math.SQRT2];

function entriesOf(instances: readonly { transform: ArrayLike<number> }[]): TwinBoundsEntry[] {
  return instances.map(instance => ({ transform: instance.transform, bounds: SPHERE }));
}

function run(name: string, instances: readonly ReferenceInstance[], vp: Float32Array, reversedZ = false) {
  const reference = buildInstanceVisibilityReference(quadGeometry(), instances,
    { viewProjection: vp, viewport: VIEWPORT, reversedZ });
  const pyramid = buildDepthPyramid(reversedZ
    ? Float32Array.from(reference.depth, depth => 1 - depth) : reference.depth.slice(), VIEWPORT[0]!, VIEWPORT[1]!, reversedZ);
  const kept = engineTwinBatchKept(entriesOf(instances), twinViewOf(vp, [0, 0, 30], reversedZ), pyramid,
    { occlusionActive: true });
  return { reference, comparison: compareInstanceVisibility(reference, kept), kept };
}

describe("T05 culling boundary matrix", () => {
  it("near-plane straddling instance stays visible; fully-behind instance is conservative-only", () => {
    const vp = viewProjection([0, 0, 30], [0, 0, 0]);
    // 近=1：绕 X 旋转 45°、尺度 0.5、中心 z=28.8 的四边形 z 跨 28.45..29.15，横跨近裁面，
    // 且横跨窄条在视锥侧平面内（近处视锥极窄，尺度必须相应收小）。
    const half = 0.5 * Math.SQRT1_2;
    const straddler: ReferenceInstance = { transform: Float32Array.from(
      [0.5, 0, 0, 0, 0, half, half, 0, 0, 0, 0, 0, 0, 0, 28.8, 1]) };
    const behind: ReferenceInstance = { transform: Float32Array.from(
      [0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 31.5, 1]) };
    const { reference, comparison } = run("near", [straddler, behind], vp);
    expect(reference.frustumVisible[0]).toBe(1);
    expect(reference.visible[0]).toBe(1);
    expect(reference.frustumVisible[1]).toBe(0);
    expect(comparison.wrongCulled).toEqual([]);
    expect(comparison.conservativeKept).toContain(1); // 相机后方实例被保守保留（fail-open），计入不判错。
  });

  it("negative scale / mirrored instances keep the identical reference set with zero wrong culls", () => {
    const vp = viewProjection([0, 0, 30], [0, 0, 0]);
    const plain = scene();
    const mirrored = scene({ mirrorX: true });
    const a = buildInstanceVisibilityReference(quadGeometry(), plain.instances, { viewProjection: vp, viewport: VIEWPORT });
    const b = buildInstanceVisibilityReference(quadGeometry(), mirrored.instances, { viewProjection: vp, viewport: VIEWPORT });
    // 布局对 x 对称：det<0 逐实例镜像后参考可见集必须逐位一致（绕序无关光栅）。
    expect([...b.visible]).toEqual([...a.visible]);
    const comparison = compareInstanceVisibility(b, engineTwinBatchKept(entriesOf(mirrored.instances),
      twinViewOf(vp), buildDepthPyramid(b.depth.slice(), VIEWPORT[0]!, VIEWPORT[1]!, false), { occlusionActive: true }));
    expect(comparison.wrongCulled).toEqual([]);
  });

  it("UTM-scale coordinates stay semantically correct with zero wrong culls", () => {
    // UTM 量级平移（f32 ABI 量化 ~0.25–0.5 于 4e6）：参考与孪生读同一量化输入，判定合同不变。
    const translate = [500_000, 0, 4_000_000] as const;
    const eye = [translate[0], translate[1], translate[2] + 30] as const;
    const vp = viewProjection(eye, [translate[0], translate[1], translate[2]]);
    const { instances, targetIds } = scene({ translate });
    const { reference, comparison } = run("utm", instances, vp);
    expect(targetIds.filter(id => reference.visible[id] === 1)).toHaveLength(4);
    expect(comparison.wrongCulled).toEqual([]);
    expect(comparison.referenceVisible).toBeGreaterThan(0);
  });

  it("transparent instances never occlude; identical scene with opaque front does", () => {
    const vp = viewProjection([0, 0, 30], [0, 0, 0]);
    const blended = scene({ frontBlend: true });
    const blendedRun = run("blend", blended.instances, vp);
    // BLEND 挡在洞前：不写深度 → 穿洞目标仍参考可见，且零错误漏剔（金字塔只含不透明集合）。
    expect(blendedRun.reference.visible[blended.instances.length - 1]).toBe(1);
    expect(blended.targetIds.filter(id => blendedRun.reference.visible[id] === 1)).toHaveLength(4);
    expect(blendedRun.comparison.wrongCulled).toEqual([]);
    // 对照：同一实例改为不透明 → 穿洞目标被前景遮挡，参考可见集不再含它们。
    const opaque = scene();
    opaque.instances[opaque.instances.length - 1] =
      { transform: Float32Array.from([3.5, 0, 0, 0, 0, 3.5, 0, 0, 0, 0, 3.5, 0, 0, 0, 12, 1]) };
    const opaqueRun = run("opaque-control", opaque.instances, vp);
    expect(opaque.targetIds.filter(id => opaqueRun.reference.visible[id] === 1)).toHaveLength(0);
    expect(opaqueRun.comparison.wrongCulled).toEqual([]);
  });
});
