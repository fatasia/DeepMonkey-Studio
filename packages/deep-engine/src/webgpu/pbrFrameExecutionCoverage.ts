import type { PbrFrameExecutionPlan } from "./pbrFramePlanExecutor.js";

/**
 * F1 真实执行 coverage:登记 pass 集(帧图计划)与本帧实际编码 pass 集的差集读数。
 * 全部为 CPU 侧量读数,不含任何时间维度;执行集合来自 render 循环的真实编码分支
 * (executedCapturePassIds),禁止从图成员关系推断。
 */
export interface PbrFrameExecutionCoverage {
  readonly frame: number;
  /** 计划身份哈希,防跨帧计划漂移(与回执 passOrder 同源)。 */
  readonly planHash: string;
  /** 登记 pass 总数(plan.passOrder.length,含未映射槽位)。 */
  readonly registeredPassCount: number;
  /** 计划中已接生产执行器的 pass 数。 */
  readonly mappedPassCount: number;
  /** 本帧实际编码的 pass 数(⊆ mappedPassIds,fail-closed 校验)。 */
  readonly executedPassCount: number;
  /** 登记且已映射但本帧未编码的 pass(directClear 等合法跳过在此显式可见)。 */
  readonly notExecutedMappedPassIds: readonly string[];
  /** executed / registered ∈ [0,1];未映射槽位计入分母(它们是登记缺口本身)。 */
  readonly executedCoverageRatio: number;
}

/**
 * 由帧图计划与本帧真实执行集合计算 coverage。执行集合包含计划外的 pass 时抛错
 * (与 createPbrFrameReceipt 同一 fail-closed 约束:单一 pass 身份来源)。
 */
export function computePbrFrameExecutionCoverage(plan: PbrFrameExecutionPlan,
  executedPassIds: ReadonlySet<string>, frame: number): PbrFrameExecutionCoverage {
  if (!Number.isSafeInteger(frame) || frame < 0) {
    throw new RangeError("Frame execution coverage frame must be a non-negative safe integer.");
  }
  const mapped = new Set(plan.mappedPassIds);
  for (const passId of executedPassIds) {
    if (!mapped.has(passId)) {
      throw new Error(`Executed pass ${passId} is not mapped in this frame plan.`);
    }
  }
  const notExecutedMappedPassIds = plan.mappedPassIds.filter(passId => !executedPassIds.has(passId));
  const registeredPassCount = plan.passOrder.length;
  return Object.freeze({
    frame,
    planHash: plan.planHash,
    registeredPassCount,
    mappedPassCount: mapped.size,
    executedPassCount: executedPassIds.size,
    notExecutedMappedPassIds: Object.freeze(notExecutedMappedPassIds),
    executedCoverageRatio: registeredPassCount === 0 ? 1 : executedPassIds.size / registeredPassCount,
  });
}
