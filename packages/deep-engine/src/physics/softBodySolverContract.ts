/**
 * T18 切片 1 软体 CPU 参考求解器 合同层(sourceSizeGate 拆分:自 softBodySolver.ts
 * 按职责分文件,代码逐行同源,仅改可见性;语义零变化。消费方仍从 softBodySolver.js
 * 导入,本文件不直接对外)。
 *
 * 职责:求解器配置/快照/体积统计的公共合同类型。
 */
import type { SoftBodyContactProjector } from "./softBodyStaticCollision.js";
import type { Vec3 } from "./physicsTypes.js";

export interface SoftBodySolverConfig {
  /** 初始顶点位置(米)。 */
  readonly positions: readonly (readonly [number, number, number])[];
  /** 四面体顶点索引;环绕方向可不统一(构建期规整为正体积)。 */
  readonly tets: readonly (readonly [number, number, number, number])[];
  /** 单质点质量(kg)。 */
  readonly mass: number;
  readonly gravity: Vec3;
  readonly dtSeconds: number;
  readonly substeps: number;
  /** 边距离约束 compliance(m/N)。 */
  readonly complianceDistance: number;
  /** 体积约束 compliance(m³/N)。 */
  readonly complianceVolume: number;
  /** 每子步线性速度阻尼系数 [0,1)。 */
  readonly damping: number;
  /** 锚点顶点索引(invMass=0)。 */
  readonly pinned: readonly number[];
  /** 地面接触平面 y = groundY(米);省略 = 无接触。积分投影式约束,
   * 确定性(same-op f64);不动锚点粒子。 */
  readonly groundY?: number;
  readonly contacts?: SoftBodyContactProjector;
  /** 表面自碰撞粒子半径(米);接触距离=2r,须满足 2r ≤ 最短四面体边。
   * 只作用于表面粒子,1 跳拓扑邻接排除。省略 = 关闭。 */
  readonly selfCollisionRadius?: number;
}

export interface SoftBodySnapshot {
  readonly tick: number;
  readonly px: Float64Array;
  readonly py: Float64Array;
  readonly pz: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  readonly vz: Float64Array;
}

export interface VolumeStats {
  /** max|V−V0|/V0(逐四面体)。 */
  readonly maxTetRatio: number;
  /** |ΣV−ΣV0|/ΣV0(整体守恒)。 */
  readonly totalRatio: number;
  readonly tetCount: number;
}
