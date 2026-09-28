import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { RobotAssetDefinition } from "@bim-studio/contracts";
import {
  buildSkeleton,
  buildSkeletonFromRobotDefinition,
  chainOf,
  effectorWorldPosition,
  isFreeJoint,
  poseFromRecord,
  poseManipulability,
  poseToRecord,
  resolvePoseValues,
  skeletonFK,
  solveSkeletonIK,
  type IKEffector,
  type IKJointLimit,
  type IKSkeleton,
  type IKSkeletonNode,
} from "./ikSkeleton";

const TIP = new THREE.Vector3(1, 0, 0);

/** 平面二连杆:肩关节在原点,肘关节距肩 1,末端距肘 1,总臂长 2。 */
function planarTwoLink(limits?: [IKJointLimit | undefined, IKJointLimit | undefined]): IKSkeleton {
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

const TWO_LINK_TIP: IKEffector = { joint: 2, offset: TIP.clone() };

describe("skeleton FK 解析解对照", () => {
  it("平面二连杆 FK(0,0) 末端在 (2,0,0)", () => {
    const skeleton = planarTwoLink();
    const world = skeletonFK(skeleton, poseFromRecord(skeleton, {}));
    expect(world[2]!.position.x).toBeCloseTo(1, 10);
    expect(effectorWorldPosition(world, skeleton, TWO_LINK_TIP).x).toBeCloseTo(2, 10);
  });

  it("FK(π/2, π/2) 肘在 (0,1,0)、末端在 (-1,1,0)", () => {
    const skeleton = planarTwoLink();
    const world = skeletonFK(skeleton, poseFromRecord(skeleton, { j1: Math.PI / 2, j2: Math.PI / 2 }));
    expect(world[2]!.position.x).toBeCloseTo(0, 10);
    expect(world[2]!.position.y).toBeCloseTo(1, 10);
    const tip = effectorWorldPosition(world, skeleton, TWO_LINK_TIP);
    expect(tip.x).toBeCloseTo(-1, 10);
    expect(tip.y).toBeCloseTo(1, 10);
  });

  it("prismatic 关节沿轴平移 q 米", () => {
    const skeleton = buildSkeleton([
      { name: "root", parent: -1, restTranslation: new THREE.Vector3(), restRotation: new THREE.Quaternion(), type: "fixed", axis: new THREE.Vector3(0, 0, 1) },
      { name: "slide", parent: 0, restTranslation: new THREE.Vector3(), restRotation: new THREE.Quaternion(), type: "prismatic", axis: new THREE.Vector3(2, 0, 0) },
    ]);
    const world = skeletonFK(skeleton, poseFromRecord(skeleton, { slide: 0.5 }));
    expect(world[1]!.position.x).toBeCloseTo(0.5, 10);
  });

  it("mimic 关节派生值 = multiplier×驱动值+offset 并按限位钳制", () => {
    const base = (): IKSkeletonNode[] => [
      { name: "root", parent: -1, restTranslation: new THREE.Vector3(), restRotation: new THREE.Quaternion(), type: "fixed", axis: new THREE.Vector3(0, 0, 1) },
      { name: "drive", parent: 0, restTranslation: new THREE.Vector3(), restRotation: new THREE.Quaternion(), type: "revolute", axis: new THREE.Vector3(0, 0, 1) },
    ];
    const unlimited = buildSkeleton([
      ...base(),
      { name: "follower", parent: 1, restTranslation: new THREE.Vector3(), restRotation: new THREE.Quaternion(), type: "revolute", axis: new THREE.Vector3(0, 0, 1), mimic: { joint: 1, multiplier: 2, offset: 0.1 } },
    ]);
    expect(resolvePoseValues(unlimited, poseFromRecord(unlimited, { drive: Math.PI / 2 }))[2]).toBeCloseTo(Math.PI + 0.1, 10);
    const clamped = buildSkeleton([
      ...base(),
      { name: "follower", parent: 1, restTranslation: new THREE.Vector3(), restRotation: new THREE.Quaternion(), type: "revolute", axis: new THREE.Vector3(0, 0, 1), limits: { lower: -1, upper: 1 }, mimic: { joint: 1, multiplier: 2, offset: 0.1 } },
    ]);
    expect(resolvePoseValues(clamped, poseFromRecord(clamped, { drive: Math.PI / 2 }))[2]).toBeCloseTo(1, 10);
  });
});

describe("从 URDF 资源定义构建骨架", () => {
  const definition = (): RobotAssetDefinition => ({
    schemaVersion: 1,
    name: "arm",
    entryPath: "arm.urdf",
    rootLink: "base",
    links: [],
    joints: [
      { name: "j1", type: "revolute", parent: "base", child: "l1", origin: { xyz: { x: 0, y: 0, z: 0.1 }, rpy: { x: 0, y: 0, z: 0 } }, axis: { x: 0, y: 0, z: 1 }, limit: { lower: -Math.PI, upper: Math.PI } },
      { name: "j2", type: "continuous", parent: "l1", child: "l2", origin: { xyz: { x: 1, y: 0, z: 0 }, rpy: { x: 0, y: 0, z: 0 } }, axis: { x: 0, y: 0, z: 1 } },
    ],
    materials: [],
    resources: [],
  });

  it("关节系位置、限位与 continuous 折叠符合 URDF 语义", () => {
    const skeleton = buildSkeletonFromRobotDefinition(definition());
    expect(skeleton.nodes.map(node => node.name)).toEqual(["base", "j1", "j2"]);
    expect(skeleton.nodes[1]!.limits).toEqual({ lower: -Math.PI, upper: Math.PI });
    expect(skeleton.nodes[2]!.limits).toBeUndefined();
    expect(isFreeJoint(skeleton.nodes[2]!)).toBe(true);
    const world = skeletonFK(skeleton, poseFromRecord(skeleton, { j1: Math.PI / 2 }));
    expect(world[2]!.position.x).toBeCloseTo(0, 10);
    expect(world[2]!.position.y).toBeCloseTo(1, 10);
    expect(world[2]!.position.z).toBeCloseTo(0.1, 10);
  });

  it("父连杆乱序声明时拓扑重排,成环与未知父连杆显式报错", () => {
    const reordered = definition();
    reordered.joints.reverse();
    expect(() => buildSkeletonFromRobotDefinition(reordered)).not.toThrow();
    const ghost = definition();
    ghost.joints[0]!.parent = "ghost-link";
    expect(() => buildSkeletonFromRobotDefinition(ghost)).toThrow(/父连杆缺失或连杆关系成环/);
    const cyclic = definition();
    cyclic.joints[0]!.parent = "l2";
    cyclic.joints[1]!.parent = "l1";
    expect(() => buildSkeletonFromRobotDefinition(cyclic)).toThrow(/父连杆缺失或连杆关系成环/);
  });
});

describe("多链限位 CCD IK", () => {
  it("可达目标残差 ≤ 臂长 0.5%(T15 验收口径)", () => {
    const skeleton = planarTwoLink();
    const solution = solveSkeletonIK(
      skeleton,
      [{ effector: TWO_LINK_TIP, position: new THREE.Vector3(1.2, 0.8, 0) }],
      { globalIterations: 64, tolerance: 1e-7 },
    );
    expect(solution.residuals[0]).toBeLessThanOrEqual(2 * 0.005);
    expect(solution.converged[0]).toBe(true);
  });

  it("不可达目标残差有限、链伸直指向目标且关节不越限位", () => {
    const skeleton = planarTwoLink([{ lower: -Math.PI, upper: Math.PI }, { lower: -Math.PI, upper: Math.PI }]);
    const solution = solveSkeletonIK(
      skeleton,
      [{ effector: TWO_LINK_TIP, position: new THREE.Vector3(5, 0, 0) }],
      { globalIterations: 64, initialPose: poseFromRecord(skeleton, { j1: Math.PI / 2, j2: 0 }) },
    );
    expect(Number.isFinite(solution.residuals[0]!)).toBe(true);
    expect(solution.converged[0]).toBe(false);
    expect(Math.abs(solution.residuals[0]! - 3)).toBeLessThanOrEqual(0.02);
    for (const index of [1, 2]) {
      expect(solution.pose[index]!).toBeGreaterThanOrEqual(-Math.PI - 1e-9);
      expect(solution.pose[index]!).toBeLessThanOrEqual(Math.PI + 1e-9);
    }
    const tip = effectorWorldPosition(skeletonFK(skeleton, solution.pose), skeleton, TWO_LINK_TIP);
    expect(tip.distanceTo(new THREE.Vector3(2, 0, 0))).toBeLessThanOrEqual(0.01);
  });

  it("限位是硬约束:关节精确停在边界且永不越界", () => {
    const skeleton = buildSkeleton([
      { name: "root", parent: -1, restTranslation: new THREE.Vector3(), restRotation: new THREE.Quaternion(), type: "fixed", axis: new THREE.Vector3(0, 0, 1) },
      { name: "j1", parent: 0, restTranslation: new THREE.Vector3(), restRotation: new THREE.Quaternion(), type: "revolute", axis: new THREE.Vector3(0, 0, 1), limits: { lower: 0, upper: Math.PI / 4 } },
    ]);
    const effector: IKEffector = { joint: 1, offset: TIP.clone() };
    const beyond = solveSkeletonIK(skeleton, [{ effector, position: new THREE.Vector3(0, 1, 0) }], { globalIterations: 32 });
    expect(beyond.pose[1]).toBeCloseTo(Math.PI / 4, 9);
    expect(beyond.pose[1]).toBeLessThanOrEqual(Math.PI / 4 + 1e-12);
    const below = solveSkeletonIK(skeleton, [{ effector, position: new THREE.Vector3(0, -1, 0) }], { globalIterations: 32, initialPose: poseFromRecord(skeleton, { j1: Math.PI / 4 }) });
    expect(below.pose[1]).toBeCloseTo(0, 9);
    expect(below.pose[1]).toBeGreaterThanOrEqual(-1e-12);
  });

  it("双链共享基座:两个目标同时收敛且结果确定性", () => {
    const skeleton = buildSkeleton([
      { name: "root", parent: -1, restTranslation: new THREE.Vector3(), restRotation: new THREE.Quaternion(), type: "fixed", axis: new THREE.Vector3(0, 0, 1) },
      { name: "base", parent: 0, restTranslation: new THREE.Vector3(), restRotation: new THREE.Quaternion(), type: "revolute", axis: new THREE.Vector3(0, 0, 1) },
      { name: "armA", parent: 1, restTranslation: new THREE.Vector3(0, 0.5, 0), restRotation: new THREE.Quaternion(), type: "revolute", axis: new THREE.Vector3(0, 0, 1) },
      { name: "armB", parent: 1, restTranslation: new THREE.Vector3(0, -0.5, 0), restRotation: new THREE.Quaternion(), type: "revolute", axis: new THREE.Vector3(0, 0, 1) },
    ]);
    const targets = [
      { effector: { joint: 2, offset: TIP.clone() }, position: new THREE.Vector3(0, 1.5, 0) },
      { effector: { joint: 3, offset: TIP.clone() }, position: new THREE.Vector3(1, -0.5, 0) },
    ];
    const first = solveSkeletonIK(skeleton, targets, { globalIterations: 64, tolerance: 1e-7 });
    const second = solveSkeletonIK(skeleton, targets, { globalIterations: 64, tolerance: 1e-7 });
    expect(first.residuals[0]).toBeLessThanOrEqual(0.01);
    expect(first.residuals[1]).toBeLessThanOrEqual(0.01);
    expect(first.pose).toEqual(second.pose);
    expect(chainOf(skeleton, 2)).toEqual([2, 1, 0]);
  });

  it("prismatic 链的限位钳制与确定性", () => {
    const skeleton = buildSkeleton([
      { name: "root", parent: -1, restTranslation: new THREE.Vector3(), restRotation: new THREE.Quaternion(), type: "fixed", axis: new THREE.Vector3(0, 0, 1) },
      { name: "slide", parent: 0, restTranslation: new THREE.Vector3(), restRotation: new THREE.Quaternion(), type: "prismatic", axis: new THREE.Vector3(1, 0, 0), limits: { lower: 0, upper: 0.5 } },
    ]);
    const solution = solveSkeletonIK(skeleton, [{ effector: { joint: 1 }, position: new THREE.Vector3(3, 0, 0) }], { globalIterations: 16 });
    expect(solution.pose[1]).toBeCloseTo(0.5, 9);
    const again = solveSkeletonIK(skeleton, [{ effector: { joint: 1 }, position: new THREE.Vector3(3, 0, 0) }], { globalIterations: 16 });
    expect(solution.pose).toEqual(again.pose);
  });
});

describe("可操作度(避奇异度量)", () => {
  it("链伸直时趋近 0,弯折时为正", () => {
    const skeleton = planarTwoLink();
    const straight = poseManipulability(skeleton, poseFromRecord(skeleton, { j1: 0, j2: 0 }), TWO_LINK_TIP);
    const bent = poseManipulability(skeleton, poseFromRecord(skeleton, { j1: 0, j2: Math.PI / 2 }), TWO_LINK_TIP);
    expect(straight).toBeLessThan(1e-6);
    expect(bent).toBeGreaterThan(0.1);
  });
});

describe("异常输入显式报错", () => {
  it("骨架结构非法", () => {
    const node = (name: string, parent: number): IKSkeletonNode => ({
      name, parent, restTranslation: new THREE.Vector3(), restRotation: new THREE.Quaternion(), type: "revolute", axis: new THREE.Vector3(0, 0, 1),
    });
    expect(() => buildSkeleton([])).toThrow(/至少需要一个节点/);
    expect(() => buildSkeleton([node("a", 0)])).toThrow(/父索引 0 非法/);
    expect(() => buildSkeleton([node("a", -1), node("a", 0)])).toThrow(/名称重复/);
    expect(() => buildSkeleton([node("a", -1), node("b", -1)])).toThrow(/多个根/);
    expect(() => buildSkeleton([{ ...node("a", -1), limits: { lower: 1, upper: 0 } }])).toThrow(/限位下界 1 大于上界 0/);
    expect(() => buildSkeleton([{ ...node("a", -1), axis: new THREE.Vector3() }])).toThrow(/轴向为零向量/);
    expect(() => buildSkeleton([
      node("a", -1),
      { ...node("b", 0), mimic: { joint: 1, multiplier: 1, offset: 0 } },
    ])).toThrow(/循环驱动/);
  });

  it("姿态记录非法", () => {
    const skeleton = planarTwoLink();
    expect(() => poseFromRecord(skeleton, { ghost: 0.1 })).toThrow(/没有关节 ghost/);
    expect(() => poseFromRecord(skeleton, { j1: Number.NaN })).toThrow();
    expect(() => poseFromRecord(skeleton, { root: 0.1 })).toThrow(/fixed,不可驱动/);
    expect(() => poseToRecord(skeleton, [0])).toThrow(/长度与骨架节点数不一致/);
  });

  it("IK 调用非法", () => {
    const skeleton = planarTwoLink();
    expect(() => solveSkeletonIK(skeleton, [{ effector: TWO_LINK_TIP, position: new THREE.Vector3(Number.NaN, 0, 0) }])).toThrow(/目标位置\.x 必须是有限数值/);
    expect(() => solveSkeletonIK(skeleton, [{ effector: TWO_LINK_TIP, position: new THREE.Vector3() }], { globalIterations: 0 })).toThrow(/全局迭代次数/);
    expect(() => solveSkeletonIK(skeleton, [{ effector: TWO_LINK_TIP, position: new THREE.Vector3() }], { initialPose: [0] })).toThrow(/初始姿态数组长度/);
    expect(() => effectorWorldPosition(skeletonFK(skeleton, [0, 0, 0]), skeleton, { joint: 9 })).toThrow(/末端关节索引非法/);
  });
});
