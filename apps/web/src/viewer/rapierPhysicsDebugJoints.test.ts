import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createPhysicsJointDebugLayer, perpendicularOf, rotatedRadial } from "./rapierPhysicsDebugJoints";
import type { PhysicsDebugJointViz } from "./rapierPhysicsDebugJoints";

function jointViz(overrides: Partial<PhysicsDebugJointViz> = {}): PhysicsDebugJointViz {
  return {
    id: "joint-1",
    kind: "revolute",
    anchor: { x: 0, y: 1, z: 0 },
    axis: { x: 0, y: 1, z: 0 },
    limits: { enabled: true, min: -0.5, max: 0.5 },
    travel: 0.25,
    limitState: "within",
    ...overrides,
  };
}

describe("rapierPhysicsDebugJoints 纯几何", () => {
  it("perpendicularOf 与轴正交；竖直轴退化为世界 X 参考（结果在 XZ 平面）", () => {
    const vertical = perpendicularOf({ x: 0, y: 1, z: 0 });
    // 正交性即语义：与轴点积为 0，且为单位向量。
    expect(vertical.x * 0 + vertical.y * 1 + vertical.z * 0).toBeCloseTo(0);
    expect(Math.hypot(vertical.x, vertical.y, vertical.z)).toBeCloseTo(1);
    const tilted = perpendicularOf({ x: 0, y: 0, z: 1 });
    expect(tilted.z).toBeCloseTo(0);
  });

  it("rotatedRadial 绕轴旋转 90° 把 +Y 参考转到 -X（右手系，轴=+Z）", () => {
    const rotated = rotatedRadial({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, Math.PI / 2);
    expect(rotated.x).toBeCloseTo(-1);
    expect(rotated.y).toBeCloseTo(0);
  });

  it("revolute 关节：轴线两侧对称 + 行程径向指针 + 双限位刻度，共 8 端点", () => {
    const layer = createPhysicsJointDebugLayer();
    layer.sync([jointViz()]);
    const geometry = (layer.object.children[0] as THREE.LineSegments).geometry;
    expect(geometry.drawRange.count).toBe(8);
    const positions = (geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
    // 主轴线：锚点 ± 0.4（轴=+Y）；顶点 i 的分量在 [i*3, i*3+2]。
    expect(positions[0]).toBeCloseTo(0);
    expect(positions[1]).toBeCloseTo(0.6);
    expect(positions[3]).toBeCloseTo(0);
    expect(positions[4]).toBeCloseTo(1.4);
    // 行程指针终点（顶点 3）：travel=0.25rad，参考≈+Y→径向在 XZ 平面，半径=RADIAL_LENGTH。
    const pointerX = positions[3 * 3]!;
    const pointerZ = positions[3 * 3 + 2]!;
    expect(Math.hypot(pointerX!, pointerZ!)).toBeCloseTo(0.28, 2);
    layer.dispose();
  });

  it("限位触限时限位刻度变红（颜色缓冲区分 within/at-limit）", () => {
    const within = createPhysicsJointDebugLayer();
    within.sync([jointViz({ limitState: "within" })]);
    const atLimit = createPhysicsJointDebugLayer();
    atLimit.sync([jointViz({ limitState: "at-limit" })]);
    const colorOf = (layer: ReturnType<typeof createPhysicsJointDebugLayer>) => {
      const geometry = (layer.object.children[0] as THREE.LineSegments).geometry;
      const colors = (geometry.getAttribute("color") as THREE.BufferAttribute).array as Float32Array;
      // 限位刻度从端点 4 开始（轴线 2 + 指针 2）。
      return [colors[4 * 3]!, colors[4 * 3 + 1]!, colors[4 * 3 + 2]!];
    };
    const [r1, g1] = colorOf(within);
    const [r2, g2] = colorOf(atLimit);
    expect(g2!).toBeLessThan(g1!); // 红色 G 通道更低
    expect(r2!).toBeGreaterThanOrEqual(r1!);
    within.dispose();
    atLimit.dispose();
  });

  it("prismatic 关节：行程沿轴偏移刻度 + 限位径向刻度", () => {
    const layer = createPhysicsJointDebugLayer();
    layer.sync([jointViz({ kind: "prismatic", axis: { x: 1, y: 0, z: 0 }, travel: 0.2, limits: { enabled: true, min: -1, max: 1 } })]);
    const geometry = (layer.object.children[0] as THREE.LineSegments).geometry;
    expect(geometry.drawRange.count).toBe(8);
    const positions = (geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
    // 行程刻度中心 x≈0.2（沿轴偏移）。
    const travelCenterX = (positions[2 * 3]! + positions[3 * 3]!) / 2;
    expect(travelCenterX).toBeCloseTo(0.2);
    layer.dispose();
  });

  it("多关节数量与 vertex 容量增长：超默认容量时 drawRange 仍精确", () => {
    const layer = createPhysicsJointDebugLayer();
    const many = Array.from({ length: 70 }, (_, index) => jointViz({ id: `j${index}` }));
    layer.sync(many);
    const geometry = (layer.object.children[0] as THREE.LineSegments).geometry;
    expect(geometry.drawRange.count).toBe(70 * 8);
    layer.sync([]);
    expect(geometry.drawRange.count).toBe(0);
    layer.dispose();
  });

  it("setVisible 与 dispose 生命周期", () => {
    const layer = createPhysicsJointDebugLayer();
    layer.setVisible(true);
    expect(layer.object.visible).toBe(true);
    const parent = new THREE.Group();
    parent.add(layer.object);
    layer.dispose();
    expect(parent.children).toHaveLength(0);
  });
});
