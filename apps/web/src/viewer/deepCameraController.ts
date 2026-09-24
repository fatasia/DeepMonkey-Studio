/**
 * 引擎中立轨道相机控制器:Deep 演示后端激活时替代 Three OrbitControls 的输入权威。
 * 纯 TypeScript 数学,不依赖 Three;与 OrbitControls 默认行为对齐(左键轨道、
 * 右键/shift 平移、滚轮推拉、指数阻尼),保证切换时操作手感一致。
 */

export type Vec3 = readonly [number, number, number];

export interface CameraPose {
  readonly eye: Vec3;
  readonly target: Vec3;
  readonly up: Vec3;
}

export interface DeepCameraControllerOptions {
  /** 最近/最远推拉距离(世界单位),默认 0.05 / 5000。 */
  minRadius: number;
  maxRadius: number;
  /** 指数阻尼系数(每秒保留比例的补),0 表示无阻尼立即结算。 */
  dampingPerSecond: number;
  /** 视场角(垂直,度),平移灵敏度换算用。 */
  verticalFovDegrees: number;
  /** 相机上向量;默认 +Y。 */
  up: Vec3;
}

export const DEFAULT_DEEP_CAMERA_OPTIONS: DeepCameraControllerOptions = {
  minRadius: 0.05,
  maxRadius: 5000,
  dampingPerSecond: 12,
  verticalFovDegrees: 50,
  up: [0, 1, 0],
};

const EPSILON = 1e-9;

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale(a: Vec3, factor: number): Vec3 {
  return [a[0] * factor, a[1] * factor, a[2] * factor];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function length(a: Vec3): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}
function normalize(a: Vec3): Vec3 {
  const magnitude = length(a);
  if (magnitude < EPSILON) throw new Error("DeepCameraController: 零向量不可归一。");
  return scale(a, 1 / magnitude);
}

/**
 * 球坐标状态。azimuth 绕 up 轴、polar 从 up 轴量起;全部交互只改这四个标量,
 * world 语义(target)与 up 由调用方拥有,保证与引擎侧相机合同单向对接。
 */
interface Spherical {
  azimuth: number;
  polar: number;
  radius: number;
}

/** 与 up 正交的稳定正交基;两个球坐标换算必须共用同一基,否则往返方位漂移。 */
function upBasis(upAxis: Vec3): { right: Vec3; forward: Vec3 } {
  const basis: Vec3 = Math.abs(upAxis[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
  const right = normalize(cross(basis, upAxis));
  const forward = normalize(cross(upAxis, right));
  return { right, forward };
}

function sphericalFromOffset(offset: Vec3, up: Vec3): Spherical {
  const radius = length(offset);
  const upAxis = normalize(up);
  // polar 相对 up 轴;up 投影平面上的方位角由 (right, forward) 正交基度量。
  const projected = subtract(offset, scale(upAxis, offset[0] * upAxis[0] + offset[1] * upAxis[1] + offset[2] * upAxis[2]));
  let azimuth = 0;
  if (length(projected) > EPSILON) {
    const { right, forward } = upBasis(upAxis);
    azimuth = Math.atan2(projected[0] * right[0] + projected[1] * right[1] + projected[2] * right[2],
      projected[0] * forward[0] + projected[1] * forward[1] + projected[2] * forward[2]);
    if (!Number.isFinite(azimuth)) azimuth = 0;
  }
  const polar = Math.acos(Math.min(1, Math.max(-1, radius < EPSILON ? 1
    : (offset[0] * upAxis[0] + offset[1] * upAxis[1] + offset[2] * upAxis[2]) / radius)));
  return { azimuth, polar, radius };
}

function offsetFromSpherical(spherical: Spherical, up: Vec3): Vec3 {
  const upAxis = normalize(up);
  const { right, forward } = upBasis(upAxis);
  const planar = Math.sin(spherical.polar);
  // 与 sphericalFromOffset 的 atan2(dot(p,right), dot(p,forward)) 约定一致:
  // azimuth 的 sin 对应 right、cos 对应 forward。
  return add(add(scale(right, spherical.radius * planar * Math.sin(spherical.azimuth)),
    scale(forward, spherical.radius * planar * Math.cos(spherical.azimuth))),
    scale(upAxis, spherical.radius * Math.cos(spherical.polar)));
}

/** 引擎中立轨道相机:所有方法都是纯状态更新,渲染由调用方 tick 驱动。 */
export class DeepCameraController {
  private readonly options: DeepCameraControllerOptions;
  private target: Vec3;
  private readonly current: Spherical;
  private readonly goal: Spherical;

  constructor(options: Partial<DeepCameraControllerOptions> = {}) {
    this.options = { ...DEFAULT_DEEP_CAMERA_OPTIONS, ...options };
    if (![this.options.minRadius, this.options.maxRadius].every(Number.isFinite)
      || this.options.minRadius <= 0 || this.options.maxRadius <= this.options.minRadius) {
      throw new Error("DeepCameraController: 推拉距离范围无效。");
    }
    this.target = [0, 0, 0];
    this.current = { azimuth: 0, polar: Math.PI / 2, radius: 10 };
    this.goal = { ...this.current };
  }

  /** 从既有相机姿态无缝接管(切换后端时调用)。 */
  setPose(eye: Vec3, target: Vec3): void {
    if (![...eye, ...target].every(Number.isFinite)) throw new Error("DeepCameraController: 相机姿态必须有限。");
    const offset = subtract(eye, target);
    if (length(offset) < EPSILON) throw new Error("DeepCameraController: eye 与 target 重合。");
    this.target = [...target] as Vec3;
    const spherical = sphericalFromOffset(offset, this.options.up);
    this.current.azimuth = spherical.azimuth; this.current.polar = spherical.polar; this.current.radius = spherical.radius;
    this.goal.azimuth = spherical.azimuth; this.goal.polar = spherical.polar; this.goal.radius = spherical.radius;
  }

  /** 左键轨道:像素增量按 OrbitControls rotateSpeed=1 公式换算。 */
  orbit(dxPixels: number, dyPixels: number, viewportHeight: number): void {
    if (![dxPixels, dyPixels, viewportHeight].every(Number.isFinite) || viewportHeight <= 0) {
      throw new Error("DeepCameraController: 轨道增量无效。");
    }
    const scale = 2 * Math.PI / viewportHeight;
    this.goal.azimuth -= dxPixels * scale;
    this.goal.polar = this.clampPolar(this.goal.polar - dyPixels * scale);
  }

  /** 右键/shift 平移:世界位移 ∝ radius,与视口高度和视场角换算。 */
  pan(dxPixels: number, dyPixels: number, viewportHeight: number): void {
    if (![dxPixels, dyPixels, viewportHeight].every(Number.isFinite) || viewportHeight <= 0) {
      throw new Error("DeepCameraController: 平移增量无效。");
    }
    const upAxis = normalize(this.options.up);
    const eye = this.eyeFrom(this.current);
    const viewDir = normalize(subtract(this.target, eye));
    const right = normalize(cross(viewDir, upAxis));
    const cameraUp = normalize(cross(right, viewDir));
    const worldPerPixel = 2 * this.current.radius * Math.tan(this.options.verticalFovDegrees * Math.PI / 360) / viewportHeight;
    const shift = add(scale(right, -dxPixels * worldPerPixel), scale(cameraUp, dyPixels * worldPerPixel));
    this.target = add(this.target, shift);
  }

  /** 滚轮推拉:每格 5%,与 OrbitControls dollyIn/dollyOut 一致。 */
  zoom(deltaSteps: number): void {
    if (!Number.isFinite(deltaSteps)) throw new Error("DeepCameraController: 推拉增量无效。");
    this.goal.radius = this.clampRadius(this.goal.radius * Math.pow(0.95, -deltaSteps));
  }

  /** 推进阻尼;返回 true 表示姿态仍在收敛,需要继续渲染。 */
  tick(dtMs: number): boolean {
    if (!Number.isFinite(dtMs) || dtMs < 0) throw new Error("DeepCameraController: tick 步长无效。");
    if (this.options.dampingPerSecond <= 0) {
      this.current.azimuth = this.goal.azimuth; this.current.polar = this.goal.polar; this.current.radius = this.goal.radius;
      return false;
    }
    const blend = 1 - Math.exp(-this.options.dampingPerSecond * dtMs / 1000);
    this.current.azimuth += (this.goal.azimuth - this.current.azimuth) * blend;
    this.current.polar += (this.goal.polar - this.current.polar) * blend;
    this.current.radius += (this.goal.radius - this.current.radius) * blend;
    return Math.abs(this.goal.azimuth - this.current.azimuth) > 1e-5
      || Math.abs(this.goal.polar - this.current.polar) > 1e-5
      || Math.abs(this.goal.radius - this.current.radius) > 1e-4 * this.goal.radius;
  }

  /** 当前姿态;eye/target/up 世界语义与引擎相机快照合同逐字段一致。 */
  getPose(): CameraPose {
    return { eye: this.eyeFrom(this.current), target: [...this.target] as Vec3, up: [...this.options.up] as Vec3 };
  }

  private eyeFrom(spherical: Spherical): Vec3 {
    return add(this.target, offsetFromSpherical(spherical, this.options.up));
  }
  private clampPolar(polar: number): number {
    const limit = Math.PI - 0.01;
    return Math.min(limit, Math.max(0.01, polar));
  }
  private clampRadius(radius: number): number {
    return Math.min(this.options.maxRadius, Math.max(this.options.minRadius, radius));
  }
}
