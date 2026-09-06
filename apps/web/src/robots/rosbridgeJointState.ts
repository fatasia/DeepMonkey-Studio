export type RosVersion = "ros1" | "ros2";
export type JointValues = Readonly<Record<string, number>>;
export type JointFrameIssue = "shape" | "names" | "duplicate" | "positions" | "optional-arrays" | "non-finite" | "stamp" | "unmapped";
export interface RosJointFrame { values: JointValues; matched: number; unknown: number; stampNs?: bigint }
export type JointFrameResult = { ok: true; frame: RosJointFrame } | { ok: false; issue: JointFrameIssue };
export const ROS_JOINT_TYPES: Record<RosVersion, string> = { ros1: "sensor_msgs/JointState", ros2: "sensor_msgs/msg/JointState" };
export const MAX_ROS_JOINTS = 512;

export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function validJointNames(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_ROS_JOINTS && value.every(name => typeof name === "string" && name.length > 0 && name.length <= 256);
}

/** 按名称而非数组序号映射。源端时钟可能是ROS仿真时间，不与浏览器epoch比较。 */
export function parseRosJointState(message: unknown, jointNames: ReadonlySet<string>, version: RosVersion): JointFrameResult {
  const fail = (issue: JointFrameIssue): JointFrameResult => ({ ok: false, issue });
  if (!isRecord(message)) return fail("shape");
  if (!validJointNames(message.name)) return fail("names");
  const names = message.name;
  if (new Set(names).size !== names.length) return fail("duplicate");
  if (!Array.isArray(message.position) || message.position.length !== names.length) return fail("positions");
  const positions = message.position;
  for (const key of ["velocity", "effort"]) {
    const value = message[key];
    if (value !== undefined && (!Array.isArray(value) || value.length !== 0 && value.length !== names.length)) return fail("optional-arrays");
    if (Array.isArray(value) && value.some(item => typeof item !== "number" || !Number.isFinite(item))) return fail("non-finite");
  }
  if (positions.some(value => typeof value !== "number" || !Number.isFinite(value))) return fail("non-finite");
  let stampNs: bigint | undefined;
  if (message.header !== undefined) {
    if (!isRecord(message.header)) return fail("stamp");
    const stamp = message.header.stamp;
    if (stamp !== undefined) {
      if (!isRecord(stamp)) return fail("stamp");
      const sec = stamp[version === "ros2" ? "sec" : "secs"], nanos = stamp[version === "ros2" ? "nanosec" : "nsecs"];
      if (typeof sec !== "number" || !Number.isSafeInteger(sec) || sec < 0 || typeof nanos !== "number" || !Number.isInteger(nanos) || nanos < 0 || nanos >= 1e9) return fail("stamp");
      if (sec || nanos) stampNs = BigInt(sec) * 1_000_000_000n + BigInt(nanos);
    }
  }
  const entries = names.flatMap((name, index) => jointNames.has(name) ? [[name, positions[index]] as const] : []);
  if (!entries.length) return fail("unmapped");
  return { ok: true, frame: { values: Object.fromEntries(entries), matched: entries.length, unknown: names.length - entries.length, ...(stampNs !== undefined ? { stampNs } : {}) } };
}

export function validRosTopic(value: string): boolean { return /^\/(?:[A-Za-z_][A-Za-z0-9_]*)(?:\/[A-Za-z_][A-Za-z0-9_]*)*$/.test(value) && value.length <= 256; }
export function validateRosbridgeUrl(value: string, securePage = false): string | undefined {
  try {
    const url = new URL(value);
    if (!["ws:", "wss:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash || url.search || securePage && url.protocol !== "wss:") return;
    return url.href;
  } catch { return; }
}
