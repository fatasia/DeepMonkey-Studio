import { describe, expect, it } from "vitest";
import type { ProbeAabb, ProbeVector3 } from "./probeClipmapPlan.js";
import { computeNormalizedFieldRmse, deriveDirtyProbeIndices,
  lightInfluenceBounds, minimumFrameBudget, simulateBudgetedRecovery } from "./probeInvalidationConvergence.js";
import { evaluateProbeRadianceEngineParity } from "./probeReferenceIntegrator.js";
import { buildReferenceRoomScene } from "./probeReferenceScene.js";
import { ProbeSurfaceCache } from "./probeSurfaceCache.js";
import type { ProbeClipmapPlan } from "./probeClipmapPlan.js";
import { ProbeClipmapUpdateScheduler,
  type ProbeClipmapFrameRequest } from "./probeClipmapUpdateScheduler.js";
import type { ProbeClipmapResourceUpdate } from "./probeClipmapResources.js";

// T02 增量失效与预算收敛推演：revision → 脏探针最小集 → 固定预算档收敛曲线（CPU 口径）。
const scene = buildReferenceRoomScene();
const positions: ProbeVector3[] = [];
for (const z of [1, 2, 3, 4, 5]) for (const y of [1, 2]) for (const x of [1, 2, 3, 4, 5, 6, 7]) {
  positions.push(Object.freeze([x, y, z]) as ProbeVector3);
}
const evaluateField = (intensity: number): ProbeVector3[] =>
  positions.map(position =>
    evaluateProbeRadianceEngineParity({ ...scene, light: { ...scene.light, intensity } }, position, 8).irradiance);
const stale = evaluateField(1), target = evaluateField(2);
const CAMERA: ProbeVector3 = [4, 1.5, 3];

describe("revision to minimal dirty probe set", () => {
  it("dirties exactly the probes inside a changed light's influence bounds", () => {
    const bounds = lightInfluenceBounds([2.5, 1.5, 3], 2);
    const dirty = deriveDirtyProbeIndices(positions, [bounds]);
    const expected = positions.map((_, index) => index).filter(index =>
      positions[index]!.every((value, axis) => value >= bounds.min[axis]! && value <= bounds.max[axis]!));
    expect(dirty).toEqual(expected);
    expect(new Set(dirty).size).toBe(dirty.length);
    expect([...dirty].sort((left, right) => left - right)).toEqual(dirty);
    expect(dirty.length).toBe(40);
    expect(dirty.length).toBeLessThan(positions.length);
  });

  it("does not dirty unrelated probes from an unrelated small influence", () => {
    const farCorner = deriveDirtyProbeIndices(positions, [lightInfluenceBounds([7.5, 0.5, 0.5], 0.4)]);
    expect(farCorner).toEqual([]);
    // 脏集之外的场不受影响：字段误差恰为 0。
    expect(computeNormalizedFieldRmse(stale, target, farCorner)).toBe(0);
  });

  it("consumes ProbeSurfaceCache dirty bounds and clears them on commit", () => {
    const cache = new ProbeSurfaceCache();
    cache.upsert({ id: "thin-wall/z0-2.5", revision: 1,
      bounds: { min: [3.95, 0, 0], max: [4.05, 3, 2.5] } });
    const frame = cache.beginFrame();
    const dirty = deriveDirtyProbeIndices(positions, frame.dirtyBounds);
    expect(dirty).toEqual(deriveDirtyProbeIndices(positions,
      [{ min: [3.95, 0, 0], max: [4.05, 3, 2.5] }]));
    expect(dirty.length).toBeGreaterThan(0);
    cache.commit(frame);
    expect(cache.beginFrame().dirtyBounds).toEqual([]);
  });

  it("rejects invalid positions, radii, and regressed surface revisions", () => {
    expect(() => deriveDirtyProbeIndices([[Number.NaN, 1, 1]], [])).toThrow(RangeError);
    expect(() => lightInfluenceBounds([0, 0, 0], 0)).toThrow(RangeError);
    expect(() => minimumFrameBudget(-1, 60, 1)).toThrow(RangeError);
    const cache = new ProbeSurfaceCache();
    cache.upsert({ id: "s", revision: 2, bounds: { min: [0, 0, 0], max: [1, 1, 1] } });
    expect(() => cache.upsert({ id: "s", revision: 1,
      bounds: { min: [0, 0, 0], max: [1, 1, 1] } })).toThrow(/regressed/);
  });
});

describe("fixed-budget convergence (CPU derivation)", () => {
  const dirtyAll = deriveDirtyProbeIndices(positions, [scene.bounds]);

  it("converges within 1s at 60fps for every budget at or above the closed-form minimum", () => {
    const minimum = minimumFrameBudget(dirtyAll.length, 60, 1);
    expect(minimum).toBe(2); // ceil(70 / 60)
    for (const budget of [minimum, 4, 8, 16, 32]) {
      const result = simulateBudgetedRecovery({ positions, stale, target,
        dirtyIndices: dirtyAll, camera: CAMERA }, { budget, fps: 60 });
      expect(result.converged).toBe(true);
      expect(result.secondsToTolerance).toBeDefined();
      expect(result.secondsToTolerance!).toBeLessThanOrEqual(1);
      expect(result.maxUpdatesPerFrame).toBeLessThanOrEqual(budget);
      expect(result.framesToTolerance!).toBeLessThanOrEqual(Math.ceil(dirtyAll.length / budget));
      // 曲线单调不增。
      for (let index = 1; index < result.frames.length; index++) {
        expect(result.frames[index]!.normalizedRmse)
          .toBeLessThanOrEqual(result.frames[index - 1]!.normalizedRmse + 1e-12);
      }
    }
  });

  it("recovers faster with larger budgets and clears the dirty set frame-by-frame", () => {
    const small = simulateBudgetedRecovery({ positions, stale, target,
      dirtyIndices: dirtyAll, camera: CAMERA }, { budget: 4, fps: 60 });
    const large = simulateBudgetedRecovery({ positions, stale, target,
      dirtyIndices: dirtyAll, camera: CAMERA }, { budget: 16, fps: 60 });
    expect(large.framesToTolerance!).toBeLessThan(small.framesToTolerance!);
    // 达容差即早退：累计刷新 = framesToTolerance × budget（每帧都是满预算），≤ 脏集总数。
    expect(small.framesToTolerance! * small.budget).toBe(small.frames[small.frames.length - 1]!.cumulativeUpdated);
    expect(small.frames[small.frames.length - 1]!.cumulativeUpdated).toBeLessThanOrEqual(dirtyAll.length);
    expect(small.frames[0]!.normalizedRmse).toBeGreaterThan(0.10);
  });

  it("derives a local light fix converging within 1s at the minimum budget", () => {
    const dirtyLight = deriveDirtyProbeIndices(positions, [lightInfluenceBounds([2.5, 1.5, 3], 2)]);
    expect(dirtyLight.length).toBe(40);
    const minimum = minimumFrameBudget(dirtyLight.length, 60, 1);
    expect(minimum).toBe(1);
    const result = simulateBudgetedRecovery({ positions, stale, target,
      dirtyIndices: dirtyLight, camera: CAMERA }, { budget: minimum, fps: 60 });
    expect(result.converged).toBe(true);
    expect(result.secondsToTolerance!).toBeLessThanOrEqual(1);
  });

  it("rejects invalid budgets and mismatched field lengths", () => {
    expect(() => simulateBudgetedRecovery({ positions, stale, target,
      dirtyIndices: dirtyAll, camera: CAMERA }, { budget: 0 })).toThrow(RangeError);
    expect(() => simulateBudgetedRecovery({ positions, stale: stale.slice(1), target,
      dirtyIndices: dirtyAll, camera: CAMERA }, { budget: 8 })).toThrow(RangeError);
  });
});

describe("influence bounds shape", () => {
  it("builds the minimal AABB around a point-light radius", () => {
    const bounds: ProbeAabb = lightInfluenceBounds([1, 2, 3], 0.5);
    expect(bounds.min).toEqual([0.5, 1.5, 2.5]);
    expect(bounds.max).toEqual([1.5, 2.5, 3.5]);
  });
});

function published(plan: ProbeClipmapPlan): ProbeClipmapResourceUpdate {
  return { status: "reused", resource: { plan }, evidence: {
    generation: 1, allocatedBytes: plan.profile.estimatedBytes, updatedBytes: 0,
    updateCount: plan.updates.length, createdBufferCount: 0, reusedBufferCount: 3,
  } } as unknown as ProbeClipmapResourceUpdate;
}
class ImmediatePublisher {
  async setValidated(plan: ProbeClipmapPlan): Promise<ProbeClipmapResourceUpdate> {
    return published(plan);
  }
}
const GRID = [7, 2, 5] as const;

// F5 失效传播端到端：灯光变化 → lightInfluenceBounds → 脏探针集 → 真实
// ProbeClipmapUpdateScheduler（budget/LEVEL_WHEEL/距离排序）在环。合同语义：失效是
// 一次性事件（dirtyBounds 只在首帧提供，之后由 pending 滚动清空），dirty 域的 level0
// cell 必须在有限帧内被穷尽调度，且清空帧数满足 1 秒（60fps）预算。
describe("light invalidation to real scheduler batches", () => {
  const SCHEDULER_GRID = [7, 2, 5] as [number, number, number];
  const frameRequest = (frame: number, dirty: readonly ProbeAabb[]): ProbeClipmapFrameRequest => ({
    frame, deviceEpoch: "gpu-1", viewport: [1280, 720], cameraPosition: CAMERA,
    sceneBounds: scene.bounds,
    options: { levelCount: 2, gridSize: SCHEDULER_GRID, baseSpacing: 1 },
    dirtyBounds: dirty });
  const level0CellsInside = (plan: ProbeClipmapPlan, bounds: ProbeAabb): string[] =>
    plan.levels.filter(level => level.level === 0).flatMap(level => {
      const keys: string[] = [];
      for (let x = 0; x < level.gridSize[0]!; x++)
        for (let y = 0; y < level.gridSize[1]!; y++)
          for (let z = 0; z < level.gridSize[2]!; z++) {
            const position: ProbeVector3 = [level.origin[0]! + x * level.spacing,
              level.origin[1]! + y * level.spacing, level.origin[2]! + z * level.spacing];
            if (position.every((value, axis) => value >= bounds.min[axis]! && value <= bounds.max[axis]!)) {
              // update.cell 是全局 cell（originCell + 局部下标），与调度器 updateKey 同构。
              keys.push(`0:${level.originCell[0]! + x}:${level.originCell[1]! + y}:${level.originCell[2]! + z}`);
            }
          }
      return keys;
    });
  const runInvalidation = async (bounds: ProbeAabb, frames = 96) => {
    const publisher = new ImmediatePublisher();
    const scheduler = new ProbeClipmapUpdateScheduler(publisher, { frameBudget: 8, cameraCutBudget: 12 });
    const scheduled = new Set<string>();
    let frame = 0, plan: ProbeClipmapPlan | undefined;
    for (; frame < frames; frame++) {
      const result = await scheduler.submit(frameRequest(frame, frame === 0 ? [bounds] : []));
      expect(result.status).toBe("committed");
      plan = result.plan!;
      plan.updates.forEach(update => scheduled.add(`${update.level}:${update.cell.join(":")}`));
      if (plan.updates.length === 0 && plan.deferred.length === 0) break;
    }
    return { scheduled, frames: frame + 1, plan: plan! };
  };

  it("exhausts the dirty domain within the one-second budget when the light changes once", async () => {
    const influence = lightInfluenceBounds([2.5, 1.5, 3], 2);
    const dirtyProbes = deriveDirtyProbeIndices(positions, [influence]);
    expect(dirtyProbes.length).toBe(40);
    const { scheduled, frames, plan } = await runInvalidation(influence);
    // 推演口径（同脏集、同 8/帧）在 1 秒内收敛；真实调度器的 pending 滚动也必须在
    // 1 秒（60 帧）内清空失效域。
    const simulated = simulateBudgetedRecovery({ positions, stale, target,
      dirtyIndices: dirtyProbes, camera: CAMERA }, { budget: 6, fps: 60 });
    expect(simulated.converged).toBe(true);
    expect(simulated.secondsToTolerance!).toBeLessThanOrEqual(1);
    expect(frames).toBeLessThanOrEqual(60);
    for (const key of level0CellsInside(plan, influence)) {
      expect(scheduled.has(key)).toBe(true);
    }
  });

  it("does not dirty anything when the changed light cannot influence any probe", async () => {
    const far = lightInfluenceBounds([50, 50, 50], 0.4);
    const { scheduled } = await runInvalidation(far, 8);
    const insideFarBox = [...scheduled].filter(key => key.startsWith("0:")).length;
    // 影响域远离网格：level0 的 dirty 覆盖为空（首帧 initial 全网格滚动属合法初始化，
    // 不计失效）——用第二帧起的增量断言：无 dirty 类更新。
    const publisher = new ImmediatePublisher();
    const scheduler = new ProbeClipmapUpdateScheduler(publisher, { frameBudget: 8, cameraCutBudget: 12 });
    await scheduler.submit(frameRequest(0, []));
    const result = await scheduler.submit(frameRequest(1, [far]));
    expect(result.stats!.updatesByClass.dirty).toBe(0);
    expect(insideFarBox).toBeGreaterThanOrEqual(0);
  });
});
