import { validJointNames, validRosTopic, type JointValues, type RosVersion } from "./rosbridgeJointState";

export interface RosTrajectoryRequest { enabled: boolean; topic: string; durationSeconds: number; values: JointValues }

/** 只构造显式单点姿态，不暗发速度命令。topic publish没有设备执行ACK。 */
export function createRosTrajectory(version: RosVersion, jointNames: readonly string[], request: RosTrajectoryRequest, id: string) {
  if (!request.enabled) throw new Error("control-disabled");
  if (!validRosTopic(request.topic)) throw new Error("control-topic");
  if (!Number.isFinite(request.durationSeconds) || request.durationSeconds < 0.1 || request.durationSeconds > 60) throw new Error("control-duration");
  if (!validJointNames(jointNames) || new Set(jointNames).size !== jointNames.length) throw new Error("control-pose");
  const positions = jointNames.map(name => Object.hasOwn(request.values, name) ? request.values[name] : undefined);
  if (positions.some(value => typeof value !== "number" || !Number.isFinite(value))) throw new Error("control-pose");
  const totalNs = Math.round(request.durationSeconds * 1e9), seconds = Math.floor(totalNs / 1e9), nanos = totalNs % 1e9;
  const duration = version === "ros2" ? { sec: seconds, nanosec: nanos } : { secs: seconds, nsecs: nanos };
  const stamp = version === "ros2" ? { sec: 0, nanosec: 0 } : { secs: 0, nsecs: 0 };
  return {
    advertise: { op: "advertise", id, topic: request.topic, type: version === "ros2" ? "trajectory_msgs/msg/JointTrajectory" : "trajectory_msgs/JointTrajectory", ...(version === "ros2" ? { qos: { history: "keep_last", depth: 1, reliability: "reliable", durability: "volatile" } } : { latch: false, queue_size: 1 }) },
    publish: { op: "publish", id, topic: request.topic, msg: { header: { ...(version === "ros1" ? { seq: 0 } : {}), stamp, frame_id: "" }, joint_names: [...jointNames], points: [{ positions, velocities: [], accelerations: [], effort: [], time_from_start: duration }] } },
  };
}
