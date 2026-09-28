import { describe, expect, it } from "vitest";
import {
  quaternionAngleBetween,
  relativeOffsetAlongAxis,
  relativeRateAlongAxis,
  relativeRotationAroundAxis,
} from "./physicsDebugSnapshot";

const Q_ID = { x: 0, y: 0, z: 0, w: 1 };
const AXIS_Y = { x: 0, y: 1, z: 0 };

/** 绕轴 angle 的四元数（右手定则）。 */
const quatAroundY = (angle: number) => ({ x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) });
const quatAroundZ = (angle: number) => ({ x: 0, y: 0, z: Math.sin(angle / 2), w: Math.cos(angle / 2) });

describe("relativeRotationAroundAxis", () => {
  it("绕 Y 轴 +0.5 rad 的相对旋转返回 0.5", () => {
    expect(relativeRotationAroundAxis(Q_ID, quatAroundY(0.5), AXIS_Y)).toBeCloseTo(0.5, 12);
  });

  it("反向旋转返回负角", () => {
    expect(relativeRotationAroundAxis(Q_ID, quatAroundY(-1.2), AXIS_Y)).toBeCloseTo(-1.2, 12);
  });

  it("绕非关节轴的旋转投影接近 0", () => {
    const AXIS_X = { x: 1, y: 0, z: 0 };
    expect(relativeRotationAroundAxis(Q_ID, quatAroundY(0.7), AXIS_X)).toBeCloseTo(0, 12);
  });

  it("±π 边界归一不跳变", () => {
    expect(relativeRotationAroundAxis(Q_ID, quatAroundY(Math.PI), AXIS_Y)).toBeCloseTo(Math.PI, 10);
    expect(relativeRotationAroundAxis(Q_ID, quatAroundY(-Math.PI), AXIS_Y)).toBeCloseTo(Math.PI, 10);
  });

  it("两体都带姿态时取相对角（q2 相对 q1）", () => {
    const angle = relativeRotationAroundAxis(quatAroundZ(0.3), quatAroundZ(1.0), { x: 0, y: 0, z: 1 });
    expect(angle).toBeCloseTo(0.7, 10);
  });

  it("quaternionAngleBetween 对 identity 为 0、π 旋转为 π", () => {
    expect(quaternionAngleBetween(Q_ID, Q_ID)).toBeCloseTo(0, 12);
    expect(quaternionAngleBetween(Q_ID, quatAroundY(Math.PI))).toBeCloseTo(Math.PI, 10);
  });
});

describe("relativeOffsetAlongAxis", () => {
  it("未旋转时投影即位移分量", () => {
    expect(relativeOffsetAlongAxis({ x: 0, y: 0, z: 0 }, Q_ID, { x: 0.3, y: 0.4, z: 0 }, { x: 1, y: 0, z: 0 })).toBeCloseTo(0.3, 12);
  });

  it("连接体旋转后按其局部系投影", () => {
    // 参考体绕 Y 转 90°：其局部 +X 指向世界 -Z；子体沿世界 -Z 移动 0.5 → 局部投影 +0.5。
    const rotated = relativeOffsetAlongAxis(
      { x: 0, y: 0, z: 0 }, quatAroundY(Math.PI / 2), { x: 0, y: 0, z: -0.5 }, { x: 1, y: 0, z: 0 },
    );
    expect(rotated).toBeCloseTo(0.5, 10);
  });
});

describe("relativeRateAlongAxis", () => {
  it("同轴角速度差直接投影", () => {
    const rate = relativeRateAlongAxis(
      { x: 0, y: 0, z: 0 }, Q_ID, { x: 0, y: 2, z: 0 }, AXIS_Y,
    );
    expect(rate).toBeCloseTo(2, 12);
  });

  it("参考体自身旋转把局部轴带到世界方向", () => {
    // 参考体绕 Z 转 90°：局部 +X → 世界 +Y；从动体角速度世界 +Y 2 rad/s → 投影 2。
    const rate = relativeRateAlongAxis(
      { x: 0, y: 0, z: 0 }, quatAroundZ(Math.PI / 2), { x: 0, y: 2, z: 0 }, { x: 1, y: 0, z: 0 },
    );
    expect(rate).toBeCloseTo(2, 10);
  });
});
