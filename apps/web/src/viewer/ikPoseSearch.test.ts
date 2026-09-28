import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { evaluatePoseCost, rankPoseCandidates, searchPoses, type PoseSearchOptions, type RankedPoseSolution } from "./ikPoseSearch";
import { buildSkeleton, poseManipulability, poseFromRecord, type IKJointLimit, type IKSkeleton, type IKSkeletonNode } from "./ikSkeleton";
import type { IKEffector } from "./ikSkeleton";

const TIP = new THREE.Vector3(1, 0, 0);
const TARGET = new THREE.Vector3(1, 1, 0);

function twoLink(limits?: [IKJointLimit | undefined, IKJointLimit | undefined]): IKSkeleton {
  const node = (name: string, parent: number, translation: THREE.Vector3, limit?: IKJointLimit): IKSkeletonNode => ({
    name,
    parent,
    restTranslation: translation,
    restRotation: new THREE.Quaternion(),
    type: "revolute",
    axis: new THREE.Vector3(0, 0, 1),
    ...(limit ? { limits: limit } : {}),
  });
  return buildSkeleton([
    { name: "root", parent: -1, restTranslation: new THREE.Vector3(), restRotation: new THREE.Quaternion(), type: "fixed", axis: new THREE.Vector3(0, 0, 1) },
    node("j1", 0, new THREE.Vector3(), limits?.[0]),
    node("j2", 1, new THREE.Vector3(1, 0, 0), limits?.[1]),
  ]);
}

const EFFECTOR: IKEffector = { joint: 2, offset: TIP.clone() };
/** 平面二连杆到达 (1,1) 的两个解析解(余弦定理):肘左与肘右。 */
const SOLUTION_ELBOW_LEFT = { j1: 0, j2: Math.PI / 2 };
const SOLUTION_ELBOW_RIGHT = { j1: Math.PI / 2, j2: -Math.PI / 2 };

describe("代价函数分解", () => {
  it("解析解位置误差为 0,接近偏好按基准姿态区分", () => {
    const skeleton = twoLink();
    const left = evaluatePoseCost(skeleton, EFFECTOR, TARGET, SOLUTION_ELBOW_LEFT);
    expect(left.positionError).toBeLessThan(1e-9);
    expect(left.limitPenalty).toBe(0);
    const nearLeft = evaluatePoseCost(skeleton, EFFECTOR, TARGET, SOLUTION_ELBOW_RIGHT, {
      preferredPose: SOLUTION_ELBOW_LEFT,
      weights: { position: 1, proximity: 5, limit: 0, singularity: 0 },
    });
    expect(nearLeft.proximity).toBeGreaterThan(1);
  });

  it("越限候选不报错,限位罚项为越限量平方和(周期等位姿态罚为正)", () => {
    const skeleton = twoLink([{ lower: -Math.PI, upper: Math.PI }, undefined]);
    const inside = evaluatePoseCost(skeleton, EFFECTOR, TARGET, SOLUTION_ELBOW_LEFT);
    const outside = evaluatePoseCost(skeleton, EFFECTOR, TARGET, { j1: 2 * Math.PI, j2: Math.PI / 2 });
    expect(outside.positionError).toBeLessThan(1e-9);
    expect(outside.limitPenalty).toBeGreaterThan(Math.PI * Math.PI - 1e-9);
    expect(inside.total).toBeLessThan(outside.total);
  });

  it("奇异姿态(链伸直)的避奇异代价显著大于弯折姿态", () => {
    const skeleton = twoLink();
    const straight = evaluatePoseCost(skeleton, EFFECTOR, new THREE.Vector3(2, 0, 0), { j1: 0, j2: 0 }, { weights: { singularity: 1 } });
    const bent = evaluatePoseCost(skeleton, EFFECTOR, new THREE.Vector3(2, 0, 0), { j1: 0.5, j2: -1.2 }, { weights: { singularity: 1 } });
    expect(straight.singularity).toBeGreaterThan(1e8);
    expect(poseManipulability(skeleton, poseFromRecord(skeleton, { j1: 0, j2: 0 }), EFFECTOR)).toBeLessThan(1e-6);
    expect(bent.singularity).toBeLessThan(100);
  });
});

describe("排序与暴力检索一致性", () => {
  it("接近偏好决定同误差解的顺序,排序完全确定", () => {
    const skeleton = twoLink();
    const options = (preferred?: Record<string, number>): PoseSearchOptions => ({
      ...(preferred ? { preferredPose: preferred } : {}),
      weights: { position: 1, proximity: 5, limit: 0, singularity: 0 },
    });
    const preferLeft = rankPoseCandidates(skeleton, EFFECTOR, TARGET, [SOLUTION_ELBOW_LEFT, SOLUTION_ELBOW_RIGHT], options(SOLUTION_ELBOW_LEFT));
    const preferRight = rankPoseCandidates(skeleton, EFFECTOR, TARGET, [SOLUTION_ELBOW_LEFT, SOLUTION_ELBOW_RIGHT], options(SOLUTION_ELBOW_RIGHT));
    expect(preferLeft[0]!.values.j1).toBeCloseTo(0, 9);
    expect(preferRight[0]!.values.j1).toBeCloseTo(Math.PI / 2, 9);
    expect(JSON.stringify(preferLeft)).toBe(JSON.stringify(rankPoseCandidates(skeleton, EFFECTOR, TARGET, [SOLUTION_ELBOW_LEFT, SOLUTION_ELBOW_RIGHT], options(SOLUTION_ELBOW_LEFT))));
  });

  it("小数据库暴力检索 argmin 与 rankPoseCandidates 首位一致;搜索不劣于暴力检索", () => {
    const skeleton = twoLink([{ lower: -1, upper: 1 }, { lower: -1, upper: 1 }]);
    const target = new THREE.Vector3(1.2, 0.8, 0);
    const database: Record<string, number>[] = [];
    for (const j1 of [-1, 0, 1]) for (const j2 of [-1, 0, 1]) database.push({ j1, j2 });
    let bruteMin = Number.POSITIVE_INFINITY;
    for (const candidate of database) {
      bruteMin = Math.min(bruteMin, evaluatePoseCost(skeleton, EFFECTOR, target, candidate).total);
    }
    const ranked = rankPoseCandidates(skeleton, EFFECTOR, target, database);
    expect(ranked[0]!.cost.total).toBe(bruteMin);
    // 网格采样(每轴 {-1,0,1})与数据库重合,refinement=0 时搜索即纯暴力检索。
    const searched = searchPoses(skeleton, EFFECTOR, target, { refinementIterations: 0, maxSeeds: 64, seeds: database });
    expect(searched[0]!.cost.total).toBe(bruteMin);
  });

  it("多解搜索返回多个可达解且同输入逐位同序(T15 确定性口径)", () => {
    const skeleton = twoLink();
    const first: RankedPoseSolution[] = searchPoses(skeleton, EFFECTOR, TARGET, { refinementIterations: 24 });
    const second: RankedPoseSolution[] = searchPoses(skeleton, EFFECTOR, TARGET, { refinementIterations: 24 });
    expect(first.length).toBeGreaterThanOrEqual(2);
    expect(first[0]!.cost.positionError).toBeLessThanOrEqual(0.01);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("异常输入显式报错", () => {
  const skeleton = twoLink();
  it("非法目标、权重与参数", () => {
    expect(() => evaluatePoseCost(skeleton, EFFECTOR, new THREE.Vector3(Number.NaN, 0, 0), { j1: 0 })).toThrow(/目标位置必须有限/);
    expect(() => searchPoses(skeleton, EFFECTOR, TARGET, { weights: { position: -1 } })).toThrow(/非负有限/);
    expect(() => searchPoses(skeleton, EFFECTOR, TARGET, { refinementIterations: -1 })).toThrow(/refinementIterations/);
    expect(() => searchPoses(skeleton, EFFECTOR, TARGET, { samplesPerJoint: 6 })).toThrow(/samplesPerJoint/);
    expect(() => searchPoses(skeleton, EFFECTOR, TARGET, { seeds: [{ ghost: 0.1 }] })).toThrow(/没有关节 ghost/);
    expect(() => rankPoseCandidates(skeleton, EFFECTOR, TARGET, [{}], { preferredPose: { ghost: 0 } })).toThrow(/没有关节 ghost/);
  });
});
