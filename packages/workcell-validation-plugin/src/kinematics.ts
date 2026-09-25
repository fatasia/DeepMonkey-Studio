import type { Vector3Value, WorkcellRobotChain } from "@bim-studio/contracts";

/** IK 位置收敛阈值(米);未达阈值即 ok=false,禁止放宽。 */
export const IK_TOLERANCE_METERS = 1e-4;
export const IK_MAX_ITERATIONS = 200;
const IK_DAMPING = 0.05;
const IK_DIFFERENTIAL_RAD = 1e-6;
/** 单轮关节步长上限(rad):阻尼最小二乘在远离解处会过冲,限幅保证单调下降。 */
const IK_MAX_STEP_RAD = 0.35;
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export interface ForwardKinematicsResult {
  /** positions[0] 为 base,positions[i] 为第 i 连杆终点,最后一项即 TCP。 */
  positions: Vector3Value[];
  tcp: Vector3Value;
}

export interface InverseKinematicsResult {
  ok: boolean;
  angles: number[];
  iterations: number;
  residualMeters: number;
  /** 任一轮迭代中关节限位裁剪实际生效过;clamped=true 时结果贴限位,供上层判定贴边风险。 */
  clamped: boolean;
}

/*
 * 关节轴约定(业务约束,消费方禁止另行假设):
 * 现有 trajectoryGeometry 只有 TCP 线段几何,没有 FK 约定,本文件声明品牌无关约定——
 * T_0 = Trans(base);T_i = T_{i-1} · Rot(axis_i, θ_i) · TransX(length_i);
 * 0° 时连杆沿局部 +X 延伸。平面链(≤3 关节)所有轴为局部 Z,运动限制在过 base 的 XY 平面;
 * 空间链(≥4 关节)轴按奇偶交替取局部 Z/Y 串联——纯 Z 串联在数学上退化为共面链,
 * 必须引入正交轴才能表达空间工作包络。该约定只服务规划层几何验证,
 * 与任何真实控制器的 DH 参数、轴序映射或后处理无关。
 */
export function jointAxis(jointIndex: number, linkCount: number): "z" | "y" {
  return linkCount <= 3 || jointIndex % 2 === 0 ? "z" : "y";
}

export function forwardKinematics(chain: WorkcellRobotChain, jointAnglesDeg: number[]): ForwardKinematicsResult {
  let rotation: Mat3 = IDENTITY;
  let point: Vector3Value = { ...chain.base };
  const positions: Vector3Value[] = [{ ...point }];
  for (let index = 0; index < chain.links.length; index += 1) {
    // 关节角缺失按 0° 补齐;超出链长的输入忽略。先绕自身轴旋转,再沿旋转后的 +X 平移连杆长度。
    const angleDeg = jointAnglesDeg[index] ?? 0;
    rotation = multiplyMatrix(rotation, jointAxis(index, chain.links.length) === "z" ? rotateZ(angleDeg) : rotateY(angleDeg));
    point = addVector(point, applyMatrix(rotation, chain.links[index]!.length, 0, 0));
    positions.push({ ...point });
  }
  return { positions, tcp: { ...point } };
}

/**
 * 数值 IK:damped least squares(J^T (JJ^T + λ²I)⁻¹),逐轮关节限位裁剪后重算;
 * 多起点(seed + 限位中点)防局部极小,取可达解中残差最小者。只用位置误差,不含姿态。
 */
export function solveIk(chain: WorkcellRobotChain, tcpTarget: Vector3Value, seedAnglesDeg?: number[]): InverseKinematicsResult {
  const count = chain.links.length;
  const clampRad = clampToLimits(chain);
  const seed = seedAnglesDeg ? seedAnglesDeg.slice(0, count).map(toRad) : undefined;
  // 多起点防局部极小:seed、限位中点、中点±量程四分之一交替、两个限位交替角点。
  // 伸直零位到同轴目标必须先增残差再绕回,严格下降搜索绕不过,必须由弯曲起点提供分支;
  // 全部确定性,无随机。clamped 聚合任一起点轮次的裁剪事实。
  const candidates = new Map<string, number[]>();
  const register = (angles: number[] | undefined) => {
    if (!angles) return;
    const bounded = clampRad(angles);
    candidates.set(bounded.join(","), bounded);
  };
  register(seed);
  register(midpointAngles(chain).map(toRad));
  register(chain.links.map((link, index) => {
    const middle = (link.minAngleDeg + link.maxAngleDeg) / 2;
    const quarter = (link.maxAngleDeg - link.minAngleDeg) / 4;
    return index % 2 === 0 ? middle + quarter : middle - quarter;
  }).map(toRad));
  register(chain.links.map((link, index) => {
    const middle = (link.minAngleDeg + link.maxAngleDeg) / 2;
    const quarter = (link.maxAngleDeg - link.minAngleDeg) / 4;
    return index % 2 === 0 ? middle - quarter : middle + quarter;
  }).map(toRad));
  // 同号折叠起点:全部关节向同一侧弯出四分之一量程;伸直奇异附近的下降路径
  // 不存在(必须先增残差),只有预弯构型能提供可行分支。
  register(chain.links.map((link) => {
    const middle = (link.minAngleDeg + link.maxAngleDeg) / 2;
    return middle + (link.maxAngleDeg - link.minAngleDeg) / 4;
  }).map(toRad));
  register(chain.links.map((link) => {
    const middle = (link.minAngleDeg + link.maxAngleDeg) / 2;
    return middle - (link.maxAngleDeg - link.minAngleDeg) / 4;
  }).map(toRad));
  register(chain.links.map((link, index) => (index % 2 === 0 ? link.minAngleDeg : link.maxAngleDeg)).map(toRad));
  register(chain.links.map((link, index) => (index % 2 === 0 ? link.maxAngleDeg : link.minAngleDeg)).map(toRad));
  let best: InverseKinematicsResult | undefined;
  let clamped = false;
  for (const start of candidates.values()) {
    const run = dampedLeastSquares(chain, tcpTarget, start, clampRad);
    clamped = clamped || run.clamped;
    const better = !best
      || (run.ok && !best.ok)
      || (run.ok === best.ok && run.residualMeters < best.residualMeters);
    if (better) best = run;
  }
  return { ...best!, clamped };
}

/**
 * 平面链前两关节解析解(0° 沿 +X、绕 Z 的约定下标准二连杆封闭解),供与数值解交叉验证;
 * 目标必须位于链平面(z 与 base 一致),第三及以后关节对位置无贡献按 0 处理。
 */
export interface AnalyticIkResult {
  reachable: boolean;
  /** 肘上/肘下两组解(度,仅前两关节);不可达时为空。 */
  solutions: number[][];
}
export function solveIkAnalytic2R(chain: WorkcellRobotChain, tcpTarget: Vector3Value): AnalyticIkResult {
  const [first, second] = chain.links;
  if (!first || !second || chain.links.length < 2) return { reachable: false, solutions: [] };
  if (Math.abs(tcpTarget.z - chain.base.z) > 1e-9) return { reachable: false, solutions: [] };
  const dx = tcpTarget.x - chain.base.x;
  const dy = tcpTarget.y - chain.base.y;
  const cosine = (dx * dx + dy * dy - first.length ** 2 - second.length ** 2) / (2 * first.length * second.length);
  if (Math.abs(cosine) > 1) return { reachable: false, solutions: [] };
  const elbow = Math.acos(Math.min(1, Math.max(-1, cosine)));
  const solutions = [-elbow, elbow].map((knee) => {
    const shoulder = Math.atan2(dy, dx) - Math.atan2(second.length * Math.sin(knee), first.length + second.length * Math.cos(knee));
    return [shoulder * RAD, knee * RAD];
  });
  return { reachable: true, solutions };
}

function dampedLeastSquares(chain: WorkcellRobotChain, tcpTarget: Vector3Value, seed: number[], clampRad: (angles: number[]) => number[]): InverseKinematicsResult {
  let angles = seed.slice();
  let clamped = false;
  let residual = tcpResidual(chain, angles, tcpTarget);
  let iterations = 0;
  for (; iterations < IK_MAX_ITERATIONS; iterations += 1) {
    if (residual < IK_TOLERANCE_METERS) break;
    const error = tcpError(chain, angles, tcpTarget);
    // 远离解时加大阻尼抑制过冲;line search 保证每轮残差单调下降,防 clamp 死锁。
    const damping = Math.max(IK_DAMPING, 0.1 * residual);
    const raw = dlsStep(jacobian(chain, angles), error, damping);
    const stepNorm = Math.hypot(raw[0]!, raw[1]!, raw[2]!);
    const scale = stepNorm > IK_MAX_STEP_RAD ? IK_MAX_STEP_RAD / stepNorm : 1;
    let accepted = false;
    let alpha = 1;
    for (let attempt = 0; attempt < 6 && !accepted; attempt += 1) {
      const proposed = angles.map((value, index) => value + raw[index]! * scale * alpha);
      const candidate = clampRad(proposed);
      const candidateResidual = tcpResidual(chain, candidate, tcpTarget);
      if (candidateResidual < residual) {
        if (candidate.some((value, index) => value !== proposed[index]!)) clamped = true;
        angles = candidate;
        residual = candidateResidual;
        accepted = true;
      } else {
        alpha /= 2;
      }
    }
    // 步长六次减半仍无改善:已到限位边界或数值死区,如实返回当前残差。
    if (!accepted) break;
  }
  return {
    ok: residual < IK_TOLERANCE_METERS,
    angles: angles.map(toDeg),
    iterations,
    residualMeters: residual,
    clamped,
  };
}

/** 雅可比按前向差分;步长 1e-6 rad 折中差分噪声与线性度。 */
function jacobian(chain: WorkcellRobotChain, angles: number[]): number[] {
  const base = forwardRad(chain, angles);
  const columns: number[] = [];
  for (let joint = 0; joint < angles.length; joint += 1) {
    const perturbed = angles.slice();
    perturbed[joint] = angles[joint]! + IK_DIFFERENTIAL_RAD;
    const moved = forwardRad(chain, perturbed);
    columns.push((moved.x - base.x) / IK_DIFFERENTIAL_RAD, (moved.y - base.y) / IK_DIFFERENTIAL_RAD, (moved.z - base.z) / IK_DIFFERENTIAL_RAD);
  }
  return columns;
}

/** Δq = Jᵀ (JJᵀ + λ²I₃)⁻¹ e;3×3 对称正定解析求逆,禁用通用矩阵库。 */
function dlsStep(jacobianColumns: number[], error: number[], damping: number): number[] {
  const joints = jacobianColumns.length / 3;
  const jjt: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let joint = 0; joint < joints; joint += 1) {
    const column = [jacobianColumns[joint * 3]!, jacobianColumns[joint * 3 + 1]!, jacobianColumns[joint * 3 + 2]!];
    for (let row = 0; row < 3; row += 1)
      for (let col = 0; col < 3; col += 1) jjt[row * 3 + col]! += column[row]! * column[col]!;
  }
  for (let diagonal = 0; diagonal < 3; diagonal += 1) jjt[diagonal * 3 + diagonal]! += damping ** 2;
  const inverse = invertSymmetric3(jjt);
  const weighted = [
    inverse[0]! * error[0]! + inverse[1]! * error[1]! + inverse[2]! * error[2]!,
    inverse[3]! * error[0]! + inverse[4]! * error[1]! + inverse[5]! * error[2]!,
    inverse[6]! * error[0]! + inverse[7]! * error[1]! + inverse[8]! * error[2]!,
  ];
  const steps: number[] = [];
  for (let joint = 0; joint < joints; joint += 1) {
    steps.push(jacobianColumns[joint * 3]! * weighted[0]! + jacobianColumns[joint * 3 + 1]! * weighted[1]! + jacobianColumns[joint * 3 + 2]! * weighted[2]!);
  }
  return steps;
}

/** 3×3 对称矩阵伴随法求逆;奇异(行列式为 0)时退化为单位阵,交由阻尼与迭代兜底。 */
function invertSymmetric3(matrix: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const determinant = a! * (e! * i! - f! * h!) - b! * (d! * i! - f! * g!) + c! * (d! * h! - e! * g!);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-18) return IDENTITY;
  return [
    (e! * i! - f! * h!) / determinant, (c! * h! - b! * i!) / determinant, (b! * f! - c! * e!) / determinant,
    (f! * g! - d! * i!) / determinant, (a! * i! - c! * g!) / determinant, (c! * d! - a! * f!) / determinant,
    (d! * h! - e! * g!) / determinant, (b! * g! - a! * h!) / determinant, (a! * e! - b! * d!) / determinant,
  ];
}

function tcpResidual(chain: WorkcellRobotChain, anglesRad: number[], tcpTarget: Vector3Value): number {
  const tcp = forwardRad(chain, anglesRad);
  return Math.hypot(tcp.x - tcpTarget.x, tcp.y - tcpTarget.y, tcp.z - tcpTarget.z);
}

function tcpError(chain: WorkcellRobotChain, anglesRad: number[], tcpTarget: Vector3Value): number[] {
  const tcp = forwardRad(chain, anglesRad);
  return [tcpTarget.x - tcp.x, tcpTarget.y - tcp.y, tcpTarget.z - tcp.z];
}

function forwardRad(chain: WorkcellRobotChain, anglesRad: number[]): Vector3Value {
  return forwardKinematics(chain, anglesRad.map(toDeg)).tcp;
}

function clampToLimits(chain: WorkcellRobotChain): (angles: number[]) => number[] {
  const lower = chain.links.map((link) => link.minAngleDeg * DEG);
  const upper = chain.links.map((link) => link.maxAngleDeg * DEG);
  return (angles: number[]) => angles.map((value, index) => Math.min(upper[index]!, Math.max(lower[index]!, value)));
}

function midpointAngles(chain: WorkcellRobotChain): number[] {
  return chain.links.map((link) => (link.minAngleDeg + link.maxAngleDeg) / 2);
}

function rotateZ(angleDeg: number): Mat3 {
  const c = Math.cos(angleDeg * DEG);
  const s = Math.sin(angleDeg * DEG);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

function rotateY(angleDeg: number): Mat3 {
  const c = Math.cos(angleDeg * DEG);
  const s = Math.sin(angleDeg * DEG);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

function multiplyMatrix(left: Mat3, right: Mat3): Mat3 {
  const result: number[] = [];
  for (let row = 0; row < 3; row += 1)
    for (let col = 0; col < 3; col += 1)
      result.push(left[row * 3]! * right[col]! + left[row * 3 + 1]! * right[3 + col]! + left[row * 3 + 2]! * right[6 + col]!);
  return result as Mat3;
}

function applyMatrix(rotation: Mat3, x: number, y: number, z: number): Vector3Value {
  return {
    x: rotation[0]! * x + rotation[1]! * y + rotation[2]! * z,
    y: rotation[3]! * x + rotation[4]! * y + rotation[5]! * z,
    z: rotation[6]! * x + rotation[7]! * y + rotation[8]! * z,
  };
}

function addVector(left: Vector3Value, right: Vector3Value): Vector3Value {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function toRad(value: number): number { return value * DEG; }
function toDeg(value: number): number { return value * RAD; }

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
type Mat3 = [number, number, number, number, number, number, number, number, number];
