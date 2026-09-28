/**
 * T28 物理调试面板的快照数据模型与关节运动学纯函数。
 * 引擎侧（viewerEngineSimulation）从 Rapier 读原始量后组装成这些纯数据；
 * 关节角度/速率换算放在本模块以便脱离引擎单测。
 */

export interface PhysicsDebugVec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface PhysicsDebugQuat {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export type PhysicsDebugBodyType = "fixed" | "dynamic" | "kinematic";

export interface PhysicsDebugBodySnapshot {
  readonly id: string;
  readonly name: string;
  readonly type: PhysicsDebugBodyType;
  readonly position: PhysicsDebugVec3;
  readonly quaternion: PhysicsDebugQuat;
  readonly linvel: PhysicsDebugVec3;
  readonly angvel: PhysicsDebugVec3;
  /** 线速度模长（m/s）。 */
  readonly speed: number;
  /** 角速度模长（rad/s）。 */
  readonly angularSpeed: number;
  readonly sleeping: boolean;
}

export interface PhysicsDebugJointSnapshot {
  readonly id: string;
  readonly kind: "revolute" | "prismatic";
  readonly solver: "impulse" | "multibody";
  readonly bodyName: string;
  readonly connectedBodyName: string;
  readonly axis: PhysicsDebugVec3;
  readonly limits: { readonly enabled: boolean; readonly min: number; readonly max: number };
  readonly motor: { readonly enabled: boolean; readonly targetVelocity: number; readonly strength: number };
  /** revolute：从动体相对连接体（或世界）绕轴的转角（rad，装配零位为 0）；prismatic：沿轴投影距离（m）。 */
  readonly travel: number;
  /** 关节轴上的相对速率：revolute 为 rad/s，prismatic 为 m/s。 */
  readonly rate: number;
  readonly limitState: "disabled" | "within" | "at-limit";
}

export interface PhysicsDebugSnapshot {
  /** 物理世界已挂载（未挂载时面板显示引导态）。 */
  readonly available: boolean;
  readonly enabled: boolean;
  readonly playing: boolean;
  /** 引擎自挂载/上次重置以来执行过的固定步总数。 */
  readonly fixedStepIndex: number;
  readonly bodies: readonly PhysicsDebugBodySnapshot[];
  readonly joints: readonly PhysicsDebugJointSnapshot[];
}

/** q2 相对 q1 绕轴（两体局部同向）的转角，结果归一到 (-π, π]。 */
export function relativeRotationAroundAxis(
  q1: PhysicsDebugQuat,
  q2: PhysicsDebugQuat,
  axis: PhysicsDebugVec3,
): number {
  // q_rel = q1^-1 * q2（标准四元数逆乘）。
  const invX = -q1.x, invY = -q1.y, invZ = -q1.z, invW = q1.w;
  const rx = invW * q2.x + invX * q2.w + invY * q2.z - invZ * q2.y;
  const ry = invW * q2.y + invY * q2.w + invZ * q2.x - invX * q2.z;
  const rz = invW * q2.z + invZ * q2.w + invX * q2.y - invY * q2.x;
  const rw = invW * q2.w - invX * q2.x - invY * q2.y - invZ * q2.z;
  const projection = rx * axis.x + ry * axis.y + rz * axis.z;
  let angle = 2 * Math.atan2(projection, rw);
  if (angle > Math.PI) angle -= 2 * Math.PI;
  if (angle <= -Math.PI) angle += 2 * Math.PI;
  return angle;
}

/** q2 相对 q1 的总旋转角（rad，短弧），用于 sanity 校验与测试。 */
export function quaternionAngleBetween(q1: PhysicsDebugQuat, q2: PhysicsDebugQuat): number {
  const dot = Math.abs(q1.x * q2.x + q1.y * q2.y + q1.z * q2.z + q1.w * q2.w);
  return 2 * Math.acos(Math.min(1, dot));
}

/** t2 相对 t1 的位移在 q1 局部系下沿 axis 的投影（m），prismatic 用。 */
export function relativeOffsetAlongAxis(
  t1: PhysicsDebugVec3,
  q1: PhysicsDebugQuat,
  t2: PhysicsDebugVec3,
  axis: PhysicsDebugVec3,
): number {
  const dx = t2.x - t1.x, dy = t2.y - t1.y, dz = t2.z - t1.z;
  // 单位四元数逆旋转：(0,d) * q^-1 的向量部分。
  const ix = q1.w * dx - q1.y * dz + q1.z * dy;
  const iy = q1.w * dy - q1.z * dx + q1.x * dz;
  const iz = q1.w * dz - q1.x * dy + q1.y * dx;
  const iw = q1.x * dx + q1.y * dy + q1.z * dz;
  const lx = ix * q1.w + iw * q1.x + iy * q1.z - iz * q1.y;
  const ly = iy * q1.w + iw * q1.y + iz * q1.x - ix * q1.z;
  const lz = iz * q1.w + iw * q1.z + ix * q1.y - iy * q1.x;
  return lx * axis.x + ly * axis.y + lz * axis.z;
}

/** 相对角速度（w2 − w1）在 axis 世界方向上的投影（rad/s）。axis 取连接体局部系，经 q1 转到世界。 */
export function relativeRateAlongAxis(
  w1: PhysicsDebugVec3,
  q1: PhysicsDebugQuat,
  w2: PhysicsDebugVec3,
  axis: PhysicsDebugVec3,
): number {
  // 单位四元数旋转向量：v' = v + w·t + q.xyz × t，t = 2·(q.xyz × v)。
  const tx = 2 * (q1.y * axis.z - q1.z * axis.y);
  const ty = 2 * (q1.z * axis.x - q1.x * axis.z);
  const tz = 2 * (q1.x * axis.y - q1.y * axis.x);
  const axisWorldX = axis.x + q1.w * tx + (q1.y * tz - q1.z * ty);
  const axisWorldY = axis.y + q1.w * ty + (q1.z * tx - q1.x * tz);
  const axisWorldZ = axis.z + q1.w * tz + (q1.x * ty - q1.y * tx);
  const dx = w2.x - w1.x, dy = w2.y - w1.y, dz = w2.z - w1.z;
  return dx * axisWorldX + dy * axisWorldY + dz * axisWorldZ;
}
