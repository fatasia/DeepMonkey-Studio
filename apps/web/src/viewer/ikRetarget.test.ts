import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  buildExplicitMapping,
  buildIsomorphicMapping,
  buildPartialMapping,
  retargetPose,
  retargetPoses,
  suggestPrismaticRatio,
  type RetargetResult,
} from "./ikRetarget";
import { buildSkeleton, type IKSkeleton, type IKSkeletonNode } from "./ikSkeleton";

type ChainOptions = { scale?: number; prismaticFirst?: boolean; limits?: { lower: number; upper: number } };

/** 等距串联链:root + 依次相连的关节,长度 = scale;可指定首关节为 prismatic 与末级限位。 */
function chainSkeleton(names: string[], options: ChainOptions = {}): IKSkeleton {
  const scale = options.scale ?? 1;
  const nodes: IKSkeletonNode[] = [
    { name: "root", parent: -1, restTranslation: new THREE.Vector3(), restRotation: new THREE.Quaternion(), type: "fixed", axis: new THREE.Vector3(0, 0, 1) },
  ];
  names.forEach((name, index) => {
    const type = index === 0 && options.prismaticFirst ? "prismatic" : "revolute";
    const limit = index === names.length - 1 ? options.limits : undefined;
    nodes.push({
      name,
      parent: index,
      restTranslation: new THREE.Vector3(scale, 0, 0),
      restRotation: new THREE.Quaternion(),
      type,
      axis: new THREE.Vector3(1, 0, 0),
      ...(limit ? { limits: limit } : {}),
    });
  });
  return buildSkeleton(nodes);
}

/** 分叉目标骨架:t1 → t2 串联,t1 同时分出 t3,与源链层级不同。 */
function branchedTargetSkeleton(limits?: { lower: number; upper: number }): IKSkeleton {
  const revolute = (name: string, parent: number, translation: THREE.Vector3, limit?: { lower: number; upper: number }): IKSkeletonNode => ({
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
    revolute("t1", 0, new THREE.Vector3()),
    revolute("t2", 1, new THREE.Vector3(3, 0, 0)),
    revolute("t3", 1, new THREE.Vector3(0, 3, 0)),
  ]);
}

describe("同构档", () => {
  it("同名同层级骨架按名直传,比例差异不影响角度值", () => {
    const source = chainSkeleton(["s1", "s2", "s3"]);
    const target = chainSkeleton(["s1", "s2", "s3"], { scale: 2 });
    const result = retargetPose(source, target, buildIsomorphicMapping(source, target), { s1: 0.5, s2: -0.25, s3: 2 });
    expect(result.pose).toEqual({ s1: 0.5, s2: -0.25, s3: 2 });
    expect(result.transferred).toEqual(["s1", "s2", "s3"]);
    expect(result.dropped).toEqual([]);
    expect(result.clamped).toEqual([]);
  });

  it("改名后不同构,显式报错并指向显式映射", () => {
    const source = chainSkeleton(["s1", "s2"]);
    const target = chainSkeleton(["a1", "s2"]);
    expect(() => buildIsomorphicMapping(source, target)).toThrow(/不同构.*buildExplicitMapping/);
  });
});

describe("缺关节档", () => {
  it("目标缺 s3 时迁移 s1/s2,丢弃并如实上报 s3", () => {
    const source = chainSkeleton(["s1", "s2", "s3"]);
    const target = chainSkeleton(["s1", "s2"]);
    const result = retargetPose(source, target, buildPartialMapping(source, target), { s1: 0.5, s2: -0.25, s3: 9 });
    expect(result.pose).toEqual({ s1: 0.5, s2: -0.25 });
    expect(result.transferred).toEqual(["s1", "s2"]);
    expect(result.dropped).toEqual(["s3"]);
  });

  it("prismatic 关节自动带首子链长度比(1→2 倍骨架)", () => {
    const source = chainSkeleton(["p1", "p2"], { prismaticFirst: true, scale: 1 });
    const target = chainSkeleton(["p1", "p2"], { prismaticFirst: true, scale: 2 });
    expect(suggestPrismaticRatio(source, target, "p1", "p1")).toBeCloseTo(2, 9);
    const result = retargetPose(source, target, buildPartialMapping(source, target), { p1: 0.5, p2: 0.3 });
    expect(result.pose.p1).toBeCloseTo(1, 9);
    expect(result.pose.p2).toBeCloseTo(0.3, 9);
  });

  it("目标关节名对不上源时显式报错", () => {
    const source = chainSkeleton(["s1", "s2"]);
    const target = chainSkeleton(["s1", "x2"]);
    expect(() => buildPartialMapping(source, target)).toThrow(/同名同型子集/);
  });
});

describe("层级不同的显式映射档", () => {
  it("分叉层级目标按映射迁移,比例/偏移生效,未映射目标关节置 0", () => {
    const source = chainSkeleton(["s1", "s2"]);
    const target = branchedTargetSkeleton();
    const mapping = buildExplicitMapping(source, target, [
      { sourceJoint: "s1", targetJoint: "t1" },
      { sourceJoint: "s2", targetJoint: "t2", ratio: 0.5, offset: 0.1 },
    ]);
    const result = retargetPose(source, target, mapping, { s1: 2, s2: -1 });
    expect(result.pose).toEqual({ t1: 2, t2: -0.4, t3: 0 });
    expect(result.transferred).toEqual(["t1", "t2"]);
    expect(result.dropped).toEqual([]);
  });

  it("目标限位重新钳制,clamped 如实记录", () => {
    const source = chainSkeleton(["s1"]);
    const target = chainSkeleton(["t1"], { limits: { lower: 0, upper: 1 } });
    const mapping = buildExplicitMapping(source, target, [{ sourceJoint: "s1", targetJoint: "t1" }]);
    const result = retargetPose(source, target, mapping, { s1: 1.7 });
    expect(result.pose.t1).toBe(1);
    expect(result.clamped).toEqual(["t1"]);
  });

  it("批量重定向保持输入顺序且与单姿态结果一致", () => {
    const source = chainSkeleton(["s1", "s2"]);
    const target = chainSkeleton(["t1", "t2"]);
    const mapping = buildExplicitMapping(source, target, [
      { sourceJoint: "s1", targetJoint: "t1" },
      { sourceJoint: "s2", targetJoint: "t2" },
    ]);
    const poses = [{ s1: 0.1, s2: 0.2 }, { s1: -0.3, s2: 0.4 }, {}];
    const batch: RetargetResult[] = retargetPoses(source, target, mapping, poses);
    expect(batch.map(result => result.pose.t1)).toEqual([0.1, -0.3, 0]);
    expect(batch[0]).toEqual(retargetPose(source, target, mapping, poses[0]!));
  });
});

describe("不支持情形显式报错(不猜)", () => {
  const source = chainSkeleton(["s1", "s2"]);
  it("映射引用未知关节", () => {
    const target = chainSkeleton(["t1"]);
    expect(() => buildExplicitMapping(source, target, [{ sourceJoint: "ghost", targetJoint: "t1" }])).toThrow(/ghost 不在源骨架/);
    expect(() => buildExplicitMapping(source, target, [{ sourceJoint: "s1", targetJoint: "ghost" }])).toThrow(/ghost 不在目标骨架/);
  });

  it("重复映射与跨类型映射", () => {
    const target = chainSkeleton(["t1", "t2"]);
    expect(() => buildExplicitMapping(source, target, [
      { sourceJoint: "s1", targetJoint: "t1" },
      { sourceJoint: "s2", targetJoint: "t1" },
    ])).toThrow(/目标关节 t1 被重复使用/);
    const prismaticTarget = chainSkeleton(["t1"], { prismaticFirst: true });
    expect(() => buildExplicitMapping(source, prismaticTarget, [{ sourceJoint: "s1", targetJoint: "t1" }])).toThrow(/关节类型不一致/);
    const revoluteTarget = chainSkeleton(["t1", "t2"]);
    expect(() => buildExplicitMapping(source, revoluteTarget, [{ sourceJoint: "s1", targetJoint: "t1", ratio: Number.NaN }])).toThrow(/ratio 必须是有限数值/);
  });

  it("mimic 派生关节不可作为映射目标", () => {
    const target = buildSkeleton([
      { name: "root", parent: -1, restTranslation: new THREE.Vector3(), restRotation: new THREE.Quaternion(), type: "fixed", axis: new THREE.Vector3(0, 0, 1) },
      { name: "drive", parent: 0, restTranslation: new THREE.Vector3(), restRotation: new THREE.Quaternion(), type: "revolute", axis: new THREE.Vector3(0, 0, 1) },
      { name: "follower", parent: 1, restTranslation: new THREE.Vector3(), restRotation: new THREE.Quaternion(), type: "revolute", axis: new THREE.Vector3(0, 0, 1), mimic: { joint: 1, multiplier: 1, offset: 0 } },
    ]);
    expect(() => buildExplicitMapping(source, target, [{ sourceJoint: "s1", targetJoint: "follower" }])).toThrow(/follower 不在目标骨架/);
  });

  it("源姿态引用未知关节", () => {
    const target = chainSkeleton(["t1"]);
    const mapping = buildExplicitMapping(source, target, [{ sourceJoint: "s1", targetJoint: "t1" }]);
    expect(() => retargetPose(source, target, mapping, { ghost: 0.1 })).toThrow(/没有关节 ghost/);
  });
});
