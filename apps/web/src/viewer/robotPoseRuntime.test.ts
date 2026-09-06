import { Group, Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";
import { ViewerEngine } from "./ViewerEngine";
import { assertRobotReplacementCompatible, readRobotDefinition, readRobotPose, restoreAuthoredRobotPose, writeRobotPose } from "./robotPoseRuntime";
import { robotDefinition, robotPoseFixture } from "./robotPoseTestFixture";

describe("URDF instance pose runtime", () => {
  it("keeps same-resource instances and authored state independent from telemetry", () => {
    const first = robotPoseFixture(), second = robotPoseFixture();
    writeRobotPose(first.object, { turn: 8 * Math.PI, slide: .08, hinge: .4 }, true);
    const saved = readRobotPose(first.object);
    writeRobotPose(first.object, { turn: .2, hinge: -.6 }, false);
    expect(first.robot.joints.turn!.angle).toBe(.2);
    expect(readRobotPose(first.object)).toEqual(saved);
    expect(second.robot.joints.turn!.angle).toBe(0);
    expect(first.robot.joints.slide!.jointValue[0]).toBe(.08);
    restoreAuthoredRobotPose(first.object);
    expect(first.robot.joints.turn!.angle).toBe(8 * Math.PI);
  });
  it("clamps before each mimic level and never drives passive values from telemetry", () => {
    const { object, robot } = robotPoseFixture();
    writeRobotPose(object, { hinge: 20, follower: -20, fixed: 30 }, true);
    expect(robot.joints.hinge!.angle).toBe(1);
    expect(robot.joints.follower!.angle).toBe(1.5);
    expect(robot.joints.chain!.angle).toBe(-2.8);
    expect(readRobotPose(object)).toEqual({ turn: 0, hinge: 1, slide: 0 });
  });
  it("uses arbitrary normalized axes, meters, and one child Z to Y conversion", () => {
    const { object, robot, coordinates } = robotPoseFixture();
    writeRobotPose(object, { slide: .2 }, true);
    expect(robot.joints.slide!.position.distanceTo(new Vector3(.2 / Math.sqrt(2), .2 / Math.sqrt(2), 0))).toBeLessThan(1e-10);
    expect(new Vector3(0, 0, 1).applyQuaternion(coordinates.quaternion).distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-10);
    expect(object.rotation.toArray().slice(0, 3)).toEqual([0, 0, 0]);
  });
  it.each([{ hinge: NaN }, { hinge: Infinity }, { hinge: .9, unknown: .2 }, JSON.parse('{"__proto__":2}')])("prevalidates the complete patch before moving any joint %j", values => {
    const { object, robot } = robotPoseFixture();
    expect(() => writeRobotPose(object, values, true)).toThrow();
    expect(robot.joints.hinge!.angle).toBe(0);
    expect(readRobotPose(object)?.hinge).toBe(0);
  });
  it("supports more than the legacy sixteen bone axes without truncation", () => {
    const definition = robotDefinition();
    definition.joints = Array.from({ length: 32 }, (_, index) => ({ ...definition.joints[0]!, name: `axis${index}`, child: `link${index}` }));
    const { object, robot } = robotPoseFixture(definition);
    writeRobotPose(object, { axis31: .5 }, true);
    expect(Object.keys(readRobotPose(object)!)).toHaveLength(32);
    expect(robot.joints.axis31!.angle).toBe(.5);
  });
  it("returns defensive state copies and preserves the runtime when its object is detached/reinstalled", () => {
    const { object, robot } = robotPoseFixture(), parent = new Group(); parent.add(object);
    writeRobotPose(object, { hinge: .7 }, true);
    readRobotDefinition(object)!.joints[0]!.name = "tampered";
    readRobotPose(object)!.hinge = -1;
    object.removeFromParent(); parent.add(object);
    expect(readRobotDefinition(object)!.joints[0]!.name).toBe("turn");
    expect(robot.joints.hinge!.angle).toBe(.7);
    expect(readRobotPose(object)!.hinge).toBe(.7);
  });
  it.each(["axis", "origin", "limit", "mimic", "parent", "type"])("rejects replacement joint semantic change: %s", property => {
    const first = robotPoseFixture(), definition = robotDefinition();
    Object.assign(definition.joints[1]!, { [property]: { axis: { x: 1, y: 0, z: 0 }, origin: { xyz: { x: 1, y: 0, z: 0 }, rpy: { x: 0, y: 0, z: 0 } }, limit: { lower: -2, upper: 2 }, mimic: { joint: "turn", multiplier: 1, offset: 0 }, parent: "different", type: "continuous" }[property] });
    const next = robotPoseFixture(definition);
    expect(() => assertRobotReplacementCompatible(first.object, next.object)).toThrow("不兼容");
  });
  it("accepts visual changes but rejects robot/nonrobot replacement", () => {
    const first = robotPoseFixture(), definition = robotDefinition(); definition.name = "New appearance";
    const next = robotPoseFixture(definition);
    expect(() => assertRobotReplacementCompatible(first.object, next.object)).not.toThrow();
    expect(() => assertRobotReplacementCompatible(first.object, new Group())).toThrow("不能");
  });
  it("keeps telemetry renderer-only while author edits notify exactly once and respect locks", () => {
    const fixture = robotPoseFixture(), engine = Object.create(ViewerEngine.prototype) as ViewerEngine;
    const model = { id: "robot", object: fixture.object }, notify = vi.fn(), shadows = vi.fn();
    Object.assign(engine, { models: new Map([[model.id, model]]), readOnlyMode: false, isModelLocked: () => false, isIsolationActive: () => false,
      updateSelectionHelper: vi.fn(), updateCollisions: vi.fn(), markShadowMapDirty: shadows, onModelChange: notify });
    expect(engine.setRobotPose("robot", { hinge: .2 })).toBe(true); expect(notify).toHaveBeenCalledTimes(1);
    Object.assign(engine, { readOnlyMode: true });
    expect(engine.setRobotPose("robot", { hinge: .7 })).toBe(false);
    expect(engine.applyRobotTelemetry("robot", { hinge: .8 })).toBe(true);
    expect(engine.getRobotPose("robot")!.hinge).toBe(.2); expect(notify).toHaveBeenCalledTimes(1);
    engine.restoreRobotPose("robot"); expect(fixture.robot.joints.hinge!.angle).toBe(.2);
    expect(engine.applyRobotTelemetry("missing", { hinge: 1 })).toBe(false);
  });
});
