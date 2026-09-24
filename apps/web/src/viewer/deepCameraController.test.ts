import { describe, expect, it } from "vitest";
import { DeepCameraController } from "./deepCameraController";

const closeTo = (actual: readonly number[], expected: readonly number[], epsilon = 1e-9) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => expect(Math.abs(value - expected[index]!)).toBeLessThan(epsilon));
};

// 引擎中立相机控制器的数学合同:往返守恒、限位、阻尼收敛、平移灵敏度。
describe("DeepCameraController", () => {
  it("round-trips an arbitrary pose through setPose/getPose", () => {
    const controller = new DeepCameraController();
    controller.setPose([8, 5, -3], [1, 2, 0.5]);
    const pose = controller.getPose();
    closeTo(pose.eye, [8, 5, -3], 1e-8);
    closeTo(pose.target, [1, 2, 0.5]);
    closeTo(pose.up, [0, 1, 0]);
  });

  it("keeps the eye-target distance constant under orbit and converges damping", () => {
    const controller = new DeepCameraController();
    controller.setPose([0, 0, 10], [0, 0, 0]);
    controller.orbit(200, -120, 800);
    for (let index = 0; index < 400 && controller.tick(16); index++) controller.getPose();
    const pose = controller.getPose();
    const radius = Math.hypot(pose.eye[0] - pose.target[0], pose.eye[1] - pose.target[1], pose.eye[2] - pose.target[2]);
    expect(Math.abs(radius - 10)).toBeLessThan(1e-6);
    // 目标角按判停阈值(1e-5 rad)结算后不再产生可感知位移(远小于一个像素)。
    const settled = controller.getPose();
    controller.tick(16);
    closeTo(controller.getPose().eye, settled.eye, 2e-4);
  });

  it("clamps polar away from the up axis and zoom into the configured radius range", () => {
    const controller = new DeepCameraController({ minRadius: 1, maxRadius: 20 });
    controller.setPose([0, 10, 0], [0, 0, 0]);
    controller.orbit(0, -50_000, 800);
    controller.zoom(-500);
    for (let index = 0; index < 600 && controller.tick(16); index++) controller.getPose();
    const pose = controller.getPose();
    const radius = Math.hypot(pose.eye[0], pose.eye[1], pose.eye[2]);
    expect(radius).toBeLessThanOrEqual(20.0001);
    expect(Math.abs(pose.eye[1]) / radius).toBeLessThan(Math.cos(0.01) + 1e-6);
    controller.zoom(2_000);
    for (let index = 0; index < 600 && controller.tick(16); index++) controller.getPose();
    expect(controller.getPose().eye[2] === 0 ? Math.hypot(...controller.getPose().eye) : Math.hypot(...controller.getPose().eye)).toBeGreaterThanOrEqual(0.9999);
  });

  it("pans along the camera plane proportionally to radius", () => {
    const controller = new DeepCameraController({ verticalFovDegrees: 50 });
    controller.setPose([0, 0, 10], [0, 0, 0]);
    controller.orbit(0, 0, 800); // 无旋转,仍需结算
    controller.tick(16);
    const worldPerPixel = 2 * 10 * Math.tan(50 * Math.PI / 360) / 800;
    controller.pan(-100, 0, 800);
    const pose = controller.getPose();
    expect(pose.target[0]).toBeCloseTo(100 * worldPerPixel, 9);
    expect(pose.target[1]).toBeCloseTo(0, 9);
    expect(pose.eye[2]).toBeCloseTo(10, 9);
  });

  it("rejects degenerate poses and invalid deltas", () => {
    const controller = new DeepCameraController();
    expect(() => controller.setPose([0, 0, 0], [0, 0, 0])).toThrow(/重合/);
    expect(() => controller.setPose([NaN, 0, 1], [0, 0, 0])).toThrow(/有限/);
    expect(() => controller.orbit(1, 1, -5)).toThrow(/无效/);
    expect(() => controller.zoom(Number.NaN)).toThrow(/无效/);
    expect(() => new DeepCameraController({ minRadius: 5, maxRadius: 5 })).toThrow(/范围/);
  });
});
