import { describe, expect, it } from "vitest";
import { URDFJoint } from "urdf-loader/src/URDFClasses.js";
import { assertLoadedRobotJoint, normalizeUrdfJointAxes, normalizedRobotAxis } from "./urdfJointNormalization";
import { robotDefinition } from "./robotPoseTestFixture";

describe("URDF validated-axis adapter", () => {
  it.each([1, 1e200, 1e308])("normalizes a finite axis of scale %s without overflow", scale => {
    const axis = normalizedRobotAxis({ x: scale, y: scale, z: 0 });
    expect(axis.length()).toBeCloseTo(1, 12); expect(axis.x).toBeCloseTo(1 / Math.sqrt(2), 12);
  });
  it.each([{ x: 0, y: 0, z: 0 }, { x: NaN, y: 0, z: 0 }, { x: Infinity, y: 0, z: 0 }])("rejects invalid axes before parsing %j", axis => {
    expect(() => normalizedRobotAxis(axis)).toThrow("轴向无效");
  });
  it.each([" 1 0 0 ", "", undefined])("fills whitespace, empty, or absent axis from the verified definition: %s", value => {
    const definition = robotDefinition(); definition.joints = [{ ...definition.joints[0]!, axis: { x: 1, y: 0, z: 0 } }];
    const attributes = new Map<string, string>(value === undefined ? [] : [["xyz", value]]);
    const axis = { nodeName: "axis", setAttribute: (key: string, next: string) => attributes.set(key, next) };
    const children = value === undefined ? [] : [axis];
    const element = { children, getAttribute: () => "turn", appendChild: (child: typeof axis) => children.push(child) };
    const document = { querySelectorAll: () => [element], createElement: () => axis } as unknown as Document;
    normalizeUrdfJointAxes(document, definition);
    expect(attributes.get("xyz")).toBe("1 0 0"); expect(children).toHaveLength(1);
  });
  it.each(["axis", "position", "quaternion"] as const)("rejects NaN %s rather than letting a comparison with NaN pass", key => {
    const definition = robotDefinition().joints[0]!, loaded = new URDFJoint(); loaded.axis.set(0, 0, 1);
    expect(() => assertLoadedRobotJoint(loaded, definition)).not.toThrow();
    loaded[key].x = NaN;
    expect(() => assertLoadedRobotJoint(loaded, definition)).toThrow("清单不一致");
  });
});
