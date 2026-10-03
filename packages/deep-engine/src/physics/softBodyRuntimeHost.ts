/**
 * F6 切片 2:布料/软体运行时会话——运行包(DynamicPhysicsRuntime.softBodies)
 * → 确定性求解器实例的生产消费链。
 *
 * 职责边界:
 * - 预算护栏第二道防线:合同解析层(runtimePackage)已 fail-closed 一次,
 *   这里在构造求解器前再校验一次(防御直接构造运行时对象的调用方);
 * - 时间基固定 1/60 秒(与 PhysicsWorldHost / NativePhysicsHost 同源),
 *   dt 不随调用方变化;
 * - 求解器按 body id 字典序构建与步进,无随机源 → 同输入同端逐位回放
 *   (physicsTypes.FixedStepSim 合同);
 * - CPU 求解器(f64)是真值;GPU 路径见 softBodyGpuDispatch(证据/加速,
 *   f32,不参与逐位合同)。
 */
import type { DynamicPhysicsRuntime, DynamicSoftBodyRuntime } from "../runtimePackage/dynamicSceneRuntime.js";
import { createSoftBodyStaticCollision } from "./softBodyStaticCollision.js";
import { createParticleSeparation, type ParticleSeparationSet } from "./clothSelfCollision.js";
import { ClothSolver, type ClothSnapshot } from "./clothSolver.js";
import { SoftBodySolver, type SoftBodySnapshot, type VolumeStats } from "./softBodySolver.js";
import type { Vec3 } from "./physicsTypes.js";

/** 运行会话预算(与 runtimePackage/dynamicSceneRuntime.ts 的解析层同源)。 */
export const SOFT_BODY_BUDGETS = {
  maxBodies: 16,
  maxParticlesPerBody: 16_384,
  maxTetsPerBody: 32_768,
  maxTotalParticles: 65_536,
  maxSubsteps: 16,
} as const;

/** 预算超限(fail-closed,错误信息给出实测与上限)。 */
export class SoftBodyBudgetError extends Error {}

const FIXED_DT = 1 / 60;

export interface SoftBodyRuntimeEntry {
  readonly id: string;
  readonly kind: "cloth" | "soft-body";
  readonly particleCount: number;
  readonly groundY?: number;
}

export interface SoftBodyRuntimeSnapshot {
  readonly tick: number;
  readonly states: ReadonlyMap<string, ClothSnapshot | SoftBodySnapshot>;
}

export interface SoftBodyRuntimeSession {
  readonly entries: readonly SoftBodyRuntimeEntry[];
  readonly tick: number;
  /** 推进全部软体一个固定 tick(id 字典序)。 */
  step(): void;
  /** 位姿读出(渲染消费;内部缓冲的拷贝,跨帧安全)。 */
  readout(id: string): Float64Array | undefined;
  /** 软体体积守恒诊断(kind=soft-body;其他 kind 返回 undefined)。 */
  volumeError(id: string): VolumeStats | undefined;
  capture(): SoftBodyRuntimeSnapshot;
  restore(snapshot: SoftBodyRuntimeSnapshot): void;
}

export interface SoftBodyRuntimeOptions {
  readonly collisionBodyIds?: readonly string[];
  /** 跨软体互碰粒子半径(米),接触距离 = 2r。首片边界:启用时全部 body 须为
   * cloth kind 且 substeps 一致、各自满足 2r ≤ spacing;同布内部自碰撞由各
   * solver 的 selfCollisionRadius 独立负责,互碰投影只处理跨集合粒子对。
   * 投影式位置分离:互碰位移不进入速度回算(非弹性接触语义),无反弹冲量。 */
  readonly mutualCollisionRadius?: number;
}

export function createSoftBodyRuntimeSession(physics: DynamicPhysicsRuntime, options: SoftBodyRuntimeOptions = {}): SoftBodyRuntimeSession {
  const softBodies = physics.softBodies ?? [];
  if (softBodies.length > SOFT_BODY_BUDGETS.maxBodies) {
    throw new SoftBodyBudgetError(
      `软体数量 ${softBodies.length} 超出预算 ${SOFT_BODY_BUDGETS.maxBodies}`,
    );
  }
  const contacts = createSoftBodyStaticCollision(physics.bodies, options.collisionBodyIds ?? []);
  const gravity: Vec3 = physics.gravity;
  let totalParticles = 0;
  const solvers = new Map<string, ClothSolver | SoftBodySolver>();
  const entries: SoftBodyRuntimeEntry[] = [];
  // 跨软体互碰:构造期 fail-closed 校验(首片仅布料、substeps 一致、2r ≤ 各自 spacing)。
  const mutualRadius = options.mutualCollisionRadius;
  let mutualSubsteps: number | undefined;
  const mutualSets: ParticleSeparationSet[] = [];
  if (mutualRadius !== undefined) {
    if (!(mutualRadius > 0) || !Number.isFinite(mutualRadius)) {
      throw new Error(`mutualCollisionRadius must be positive finite, got ${mutualRadius}.`);
    }
    for (const body of softBodies) {
      if (body.kind !== "cloth") {
        throw new Error(`软体互碰首片仅支持 cloth,${body.id} 是 ${body.kind}。`);
      }
      if (2 * mutualRadius > body.spacing) {
        throw new Error(`软体 ${body.id} 互碰半径违反 2r ≤ spacing(${2 * mutualRadius} > ${body.spacing})。`);
      }
      if (mutualSubsteps === undefined) mutualSubsteps = body.substeps;
      else if (mutualSubsteps !== body.substeps) {
        throw new Error(`软体互碰要求全部 body substeps 一致(${mutualSubsteps} vs ${body.substeps})。`);
      }
    }
  }
  for (const body of softBodies) {
    const particleCount = body.kind === "cloth" ? body.columns * body.rows : body.positions.length;
    if (particleCount > SOFT_BODY_BUDGETS.maxParticlesPerBody) {
      throw new SoftBodyBudgetError(
        `软体 ${body.id} 粒子数 ${particleCount} 超出单体贴算 ${SOFT_BODY_BUDGETS.maxParticlesPerBody}`,
      );
    }
    if (body.substeps > SOFT_BODY_BUDGETS.maxSubsteps) {
      throw new SoftBodyBudgetError(
        `软体 ${body.id} substeps ${body.substeps} 超出预算 ${SOFT_BODY_BUDGETS.maxSubsteps}`,
      );
    }
    totalParticles += particleCount;
    if (totalParticles > SOFT_BODY_BUDGETS.maxTotalParticles) {
      throw new SoftBodyBudgetError(
        `软体粒子总量 ${totalParticles} 超出预算 ${SOFT_BODY_BUDGETS.maxTotalParticles}`,
      );
    }
    if (body.kind === "cloth") {
      const solver = new ClothSolver({
        columns: body.columns, rows: body.rows, spacing: body.spacing, mass: body.mass,
        gravity, dtSeconds: FIXED_DT, substeps: body.substeps, compliance: body.compliance,
        damping: body.damping, perturbation: body.perturbation, seed: body.seed,
        origin: body.origin,
        ...(contacts ? { contacts } : {}),
        ...(body.groundY === undefined ? {} : { groundY: body.groundY }),
        ...(body.wind === undefined ? {} : {
          wind: {
            direction: body.wind.direction, baseSpeed: body.wind.baseSpeed,
            gustFrequency: body.wind.gustFrequency, spatialScale: body.wind.spatialScale,
            seed: body.wind.seed,
          },
        }),
      });
      for (const pinned of body.pinned) solver.setPinnedIndex(pinned);
      solvers.set(body.id, solver);
      entries.push({ id: body.id, kind: "cloth", particleCount, ...(body.groundY === undefined ? {} : { groundY: body.groundY }) });
    } else {
      if (body.tets.length > SOFT_BODY_BUDGETS.maxTetsPerBody) {
        throw new SoftBodyBudgetError(
          `软体 ${body.id} 四面体数 ${body.tets.length} 超出预算 ${SOFT_BODY_BUDGETS.maxTetsPerBody}`,
        );
      }
      const solver = new SoftBodySolver({
        positions: body.positions, tets: body.tets, mass: body.mass, gravity,
        dtSeconds: FIXED_DT, substeps: body.substeps, complianceDistance: body.complianceDistance,
        complianceVolume: body.complianceVolume, damping: body.damping, pinned: body.pinned,
        ...(contacts ? { contacts } : {}),
        ...(body.groundY === undefined ? {} : { groundY: body.groundY }),
      });
      solvers.set(body.id, solver);
      entries.push({ id: body.id, kind: "soft-body", particleCount, ...(body.groundY === undefined ? {} : { groundY: body.groundY }) });
    }
  }

  // 互碰分离核:子步后投影,只处理跨集合粒子对(同布内部走各自 selfCollisionRadius)。
  const mutualSeparation = mutualRadius === undefined || solvers.size === 0 ? undefined : createParticleSeparation({
    sets: [...solvers.values()].map(solver => solver.particleBuffers()),
    diameter: 2 * mutualRadius,
    crossOnly: true,
  });

  let tick = 0;
  return {
    entries,
    get tick(): number { return tick; },
    step(): void {
      if (mutualSeparation) {
        const substeps = mutualSubsteps ?? 1;
        for (let sub = 0; sub < substeps; sub += 1) {
          for (const solver of solvers.values()) solver.stepSubstep(sub);
          mutualSeparation.resolve();
        }
      } else {
        for (const solver of solvers.values()) solver.step();
      }
      tick += 1;
    },
    readout(id: string): Float64Array | undefined {
      const solver = solvers.get(id);
      if (!solver) return undefined;
      return solver.positionsInterleaved();
    },
    volumeError(id: string): VolumeStats | undefined {
      const solver = solvers.get(id);
      return solver instanceof SoftBodySolver ? solver.measureVolumeError() : undefined;
    },
    capture(): SoftBodyRuntimeSnapshot {
      const states = new Map<string, ClothSnapshot | SoftBodySnapshot>();
      for (const [id, solver] of solvers) states.set(id, solver.capture());
      return { tick, states };
    },
    restore(snapshot: SoftBodyRuntimeSnapshot): void {
      for (const [id, solver] of solvers) {
        const state = snapshot.states.get(id);
        if (!state) throw new Error(`软体 ${id} 的快照缺失,无法恢复`);
        solver.restore(state);
      }
      tick = snapshot.tick;
    },
  };
}
