import { describe, expect, it } from "vitest";
import { buildInstanceVisibilityReference, compareInstanceVisibility,
  type ReferenceVisibility } from "./instanceVisibilityReference.js";
import { buildDepthPyramid, engineTwinBatchKept, type TwinBoundsEntry } from "./instanceVisibilityTwin.js";
import { quadGeometry, scene, twinViewOf, viewProjection, VIEWPORT } from "./instanceVisibilityFixture.js";

/**
 * T05 验收切片：参考可见集 ⊆ 引擎保留集（零错误漏剔）。
 * 判定合同：wrongCulled（参考判可见但引擎剔除）= 硬错误必须为空；
 * conservativeKept（参考判不可见但引擎保留）= 保守可接受，逐条计数。
 */

const SPHERE: readonly [number, number, number, number] = [0, 0, 0, Math.SQRT2];

function entriesOf(instances: readonly { transform: ArrayLike<number> }[]): TwinBoundsEntry[] {
  return instances.map(instance => ({ transform: instance.transform, bounds: SPHERE }));
}

function rawDepth(reference: ReferenceVisibility, reversedZ: boolean): Float32Array {
  // 金字塔存深度缓冲原值（reversedZ：大=近）；参考 depth 是「小=近」光栅约定，需翻回。
  return reversedZ ? Float32Array.from(reference.depth, depth => 1 - depth) : reference.depth.slice();
}

describe("T05 instance visibility reference set", () => {
  it("reference finds through-hole targets and occluded targets", () => {
    const vp = viewProjection([0, 0, 30], [0, 0, 0]);
    const { instances, targetIds } = scene();
    const reference = buildInstanceVisibilityReference(quadGeometry(), instances, { viewProjection: vp, viewport: VIEWPORT });
    const visibleTargets = targetIds.filter(id => reference.visible[id] === 1);
    const occludedTargets = targetIds.filter(id => reference.visible[id] === 0);
    // 相机 (0,0,30) 穿洞视线只对准 ±1.6 的四个目标；±4.8 的目标被墙块挡住。
    expect(visibleTargets).toHaveLength(4);
    expect(occludedTargets.length).toBeGreaterThanOrEqual(12);
    expect(reference.visible.reduce((sum, value) => sum + value, 0)).toBeGreaterThan(visibleTargets.length);
  });

  it("zero wrong culls: reference visible set survives the engine frustum twin", () => {
    const vp = viewProjection([0, 0, 30], [0, 0, 0]);
    const { instances } = scene();
    const reference = buildInstanceVisibilityReference(quadGeometry(), instances, { viewProjection: vp, viewport: VIEWPORT });
    const kept = engineTwinBatchKept(entriesOf(instances), twinViewOf(vp),
      { levels: [], mipLevelCount: 1 }, { occlusionActive: false });
    const comparison = compareInstanceVisibility(reference, kept);
    expect(comparison.wrongCulled).toEqual([]);
    expect(comparison.referenceVisible).toBeGreaterThan(0);
  });

  it("zero wrong culls: reference visible set survives the Hi-Z occlusion twin", () => {
    const vp = viewProjection([0, 0, 30], [0, 0, 0]);
    const { instances } = scene();
    const reference = buildInstanceVisibilityReference(quadGeometry(), instances, { viewProjection: vp, viewport: VIEWPORT });
    const pyramid = buildDepthPyramid(rawDepth(reference, false), VIEWPORT[0]!, VIEWPORT[1]!, false);
    const kept = engineTwinBatchKept(entriesOf(instances), twinViewOf(vp), pyramid, { occlusionActive: true });
    const comparison = compareInstanceVisibility(reference, kept);
    expect(comparison.wrongCulled).toEqual([]);
    // 遮挡路径必须比纯视锥保留得更少——否则场景未行使遮挡剔除（保守计数随比较报告）。
    expect(kept.reduce((sum, value) => sum + value, 0))
      .toBeLessThan(instances.length);
    const frustumKept = engineTwinBatchKept(entriesOf(instances), twinViewOf(vp),
      { levels: [], mipLevelCount: 1 }, { occlusionActive: false });
    expect(kept.reduce((sum, value) => sum + value, 0))
      .toBeLessThan(frustumKept.reduce((sum, value) => sum + value, 0));
  });

  it("reversedZ views produce the identical reference set and zero wrong culls", () => {
    const forward = viewProjection([0, 0, 30], [0, 0, 0]);
    const reversed = viewProjection([0, 0, 30], [0, 0, 0], true);
    const { instances, targetIds } = scene();
    const standard = buildInstanceVisibilityReference(quadGeometry(), instances,
      { viewProjection: forward, viewport: VIEWPORT });
    const flipped = buildInstanceVisibilityReference(quadGeometry(), instances,
      { viewProjection: reversed, viewport: VIEWPORT, reversedZ: true });
    expect([...flipped.visible]).toEqual([...standard.visible]);
    const pyramid = buildDepthPyramid(rawDepth(flipped, true), VIEWPORT[0]!, VIEWPORT[1]!, true);
    const kept = engineTwinBatchKept(entriesOf(instances), twinViewOf(reversed, [0, 0, 30], true), pyramid,
      { occlusionActive: true });
    const comparison = compareInstanceVisibility(flipped, kept);
    expect(comparison.wrongCulled).toEqual([]);
    expect(targetIds.filter(id => flipped.visible[id] === 1)).toHaveLength(4);
  });
});
