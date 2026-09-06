import { describe, expect, it } from "vitest";
import { parseRosJointState, validateRosbridgeUrl, validRosTopic } from "./rosbridgeJointState";
import { createRosTrajectory } from "./rosbridgeTrajectory";
const joints = new Set(["axis", "slide"]);
const frame = { name: ["slide", "unmapped", "axis"], position: [0.1, 3, 0.5], velocity: [], effort: [] };
describe("ROS JointState boundary", () => {
  it("maps SI positions by name, ignores unknown joints and distinguishes ROS timestamps", () => {
    expect(parseRosJointState({ ...frame, header: { stamp: { sec: 1, nanosec: 2 } } }, joints, "ros2")).toEqual({ ok: true, frame: { values: { slide: 0.1, axis: 0.5 }, matched: 2, unknown: 1, stampNs: 1_000_000_002n } });
    expect(parseRosJointState({ ...frame, header: { stamp: { secs: 1, nsecs: 2 } } }, joints, "ros1")).toMatchObject({ ok: true, frame: { stampNs: 1_000_000_002n } });
    expect(parseRosJointState({ ...frame, header: { stamp: { sec: 0, nanosec: 0 } } }, joints, "ros2")).toMatchObject({ ok: true, frame: { matched: 2 } });
  });
  it.each([
    [null, "shape"], [{ name: [], position: [] }, "names"], [{ name: ["axis", "axis"], position: [1, 2] }, "duplicate"],
    [{ ...frame, position: [] }, "positions"], [{ ...frame, velocity: [1] }, "optional-arrays"], [{ ...frame, position: [0, NaN, 2] }, "non-finite"],
    [{ ...frame, effort: [1, Infinity, 1] }, "non-finite"], [{ ...frame, header: { stamp: { sec: 1, nanosec: 1e9 } } }, "stamp"],
    [{ ...frame, header: { stamp: { secs: 1, nsecs: 0 } } }, "stamp"], [{ name: ["no-match"], position: [1] }, "unmapped"],
  ])("rejects malformed or unmapped telemetry: %s", (input, issue) => expect(parseRosJointState(input, joints, "ros2")).toEqual({ ok: false, issue }));
  it("does not interpret names as object prototypes", () => {
    const result = parseRosJointState({ name: ["__proto__"], position: [2] }, new Set(["__proto__"]), "ros2");
    expect(result.ok && Object.hasOwn(result.frame.values, "__proto__")).toBe(true);
  });
  it.each(["http://localhost:9090", "ws://admin:secret@localhost:9090", "ws://localhost:9090/?token=secret", "ws://localhost:9090/#token"]) ("rejects invalid or credential-bearing URLs without returning them", url => expect(validateRosbridgeUrl(url)).toBeUndefined());
  it("requires wss on secure pages and rejects malformed topics", () => {
    expect(validateRosbridgeUrl("ws://localhost:9090", true)).toBeUndefined();
    expect(validateRosbridgeUrl("wss://robot.local/bridge", true)).toBe("wss://robot.local/bridge");
    expect(validRosTopic("/joint_states")).toBe(true); expect(validRosTopic("/foo//bar")).toBe(false);
  });
});
describe("explicit single-point JointTrajectory", () => {
  const request = { enabled: true, topic: "/controller/joint_trajectory", durationSeconds: 1.25, values: { axis: 0.5, slide: 0.1 } };
  it("preserves caller joint order and uses non-latching ROS1/ROS2 structures", () => {
    const ros2 = createRosTrajectory("ros2", ["slide", "axis"], request, "1");
    expect(ros2.advertise).toMatchObject({ type: "trajectory_msgs/msg/JointTrajectory", qos: { durability: "volatile", depth: 1 } });
    expect(ros2.publish.msg.points[0]).toMatchObject({ positions: [0.1, 0.5], time_from_start: { sec: 1, nanosec: 250_000_000 } });
    const ros1 = createRosTrajectory("ros1", ["axis", "slide"], request, "2");
    expect(ros1.advertise).toMatchObject({ type: "trajectory_msgs/JointTrajectory", latch: false });
    expect(ros1.publish.msg.points[0]).toMatchObject({ time_from_start: { secs: 1, nsecs: 250_000_000 } });
  });
  it("requires explicit enablement, valid topic/duration and a complete finite pose", () => {
    expect(() => createRosTrajectory("ros2", ["axis"], { ...request, enabled: false }, "1")).toThrow("control-disabled");
    expect(() => createRosTrajectory("ros2", ["axis"], { ...request, topic: "" }, "1")).toThrow("control-topic");
    expect(() => createRosTrajectory("ros2", ["axis"], { ...request, durationSeconds: NaN }, "1")).toThrow("control-duration");
    expect(() => createRosTrajectory("ros2", ["missing"], request, "1")).toThrow("control-pose");
  });
});
