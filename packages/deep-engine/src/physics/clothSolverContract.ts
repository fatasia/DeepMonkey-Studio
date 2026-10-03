/**
 * T18 切片 1 布料 CPU 参考求解器 合同层(sourceSizeGate 拆分:自 clothSolver.ts
 * 按职责分文件,代码逐行同源,仅改可见性;语义零变化。消费方仍从 clothSolver.js
 * 导入,本文件不直接对外)。
 *
 * 职责:确定性风场合同、求解器配置/快照/拉伸统计的公共合同类型、风噪声盐值常量。
 */
import type { SoftBodyContactProjector } from "./softBodyStaticCollision.js";
import type { Vec3 } from "./physicsTypes.js";

/** 确定性风场:加速度 = direction × baseSpeed × gustFactor(noise(t·f, y·scale)∈[0,1] 映射到 [0.5,1.5])。 */
export interface ClothWind {
  readonly direction: Vec3;
  readonly baseSpeed: number;
  readonly gustFrequency: number;
  readonly spatialScale: number;
  readonly seed: number;
}

export interface ClothSolverConfig {
  readonly columns: number;
  readonly rows: number;
  /** 网格静止间距(米),结构约束共用;剪切约束 rest = spacing·√2。 */
  readonly spacing: number;
  /** 单质点质量(kg)。 */
  readonly mass: number;
  readonly gravity: Vec3;
  /** 固定步长(秒),仿真内部唯一时间基。 */
  readonly dtSeconds: number;
  readonly substeps: number;
  /** XPBD compliance(m/N);0 = 刚性约束。 */
  readonly compliance: number;
  /** 每子步线性速度阻尼系数 [0,1)。 */
  readonly damping: number;
  /** seed 驱动的初始 z 向扰动幅度(米),≥0;0 = 完全平整初始态。 */
  readonly perturbation: number;
  readonly seed: number;
  /** 初始布局平移(米);省略 = [0,0,0]。运行包 F6 通道消费。 */
  readonly origin?: Vec3;
  /** 地面接触平面 y = groundY(米);省略 = 无接触。积分投影式约束,
   * 确定性(same-op f64);不动锚点粒子。 */
  readonly groundY?: number;
  readonly contacts?: SoftBodyContactProjector;
  /** 布料自碰撞粒子半径(米);接触距离=2r,须满足 2r ≤ spacing
   * (拓扑相邻粒子距离 ≥ spacing,天然不触发)。省略 = 关闭。 */
  readonly selfCollisionRadius?: number;
  readonly wind?: ClothWind | null;
}

export interface ClothSnapshot {
  readonly tick: number;
  readonly px: Float64Array;
  readonly py: Float64Array;
  readonly pz: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  readonly vz: Float64Array;
}

export interface StretchStats {
  /** max|len−rest|/rest(全约束;双锚点约束恒为 0)。 */
  readonly maxRatio: number;
  readonly meanRatio: number;
  readonly constraintCount: number;
}

export const WIND_NOISE_SALT = 0x51ed2701;
