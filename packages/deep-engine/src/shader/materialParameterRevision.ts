/** T08 GPU 联测切片 · 参数变更 → 求值缓存/累积重置语义。
 * 对照 T10 验收口径的精神(「材质变更立即重置累积,事件→generation 合同」):
 * 扩展材质参数的任何键变化(按 f32 逐位相等判定,不做 epsilon 比较——参数本身已是
 * fround 后的规范值)必须:①bump 求值 generation;②使求值缓存与累积缓冲同时失效。
 * 不允许部分重置:clearcoat/各向异性/透射共享同一次 layering 求值,任何键漂移都会
 * 改变层叠输出。消费方(渲染管线的实例上传/累积器)按 generation 变化执行重置。 */

import { MATERIAL_PARAMETER_KEYS, packMaterialParameterArray,
  type ExtendedMaterialParameters, type MaterialParameterKey } from "./materialParameters.js";

export const MATERIAL_PARAMETER_RESET_CONTRACT_VERSION = 1 as const;

export interface MaterialParameterChange {
  readonly changed: boolean;
  /** 逐位变化的键(顺序同 MATERIAL_PARAMETER_KEYS);changed=false 时为空数组。 */
  readonly changedKeys: readonly MaterialParameterKey[];
}

const sameF32 = (left: number, right: number): boolean => left === right;

/** 逐键位级比较(fround 后比较,0 与 -0 视为相等)。 */
export function compareMaterialParameters(
  previous: ExtendedMaterialParameters, next: ExtendedMaterialParameters,
): MaterialParameterChange {
  const before = packMaterialParameterArray(previous);
  const after = packMaterialParameterArray(next);
  const changedKeys = MATERIAL_PARAMETER_KEYS.filter((_, index) => !sameF32(before[index]!, after[index]!));
  return { changed: changedKeys.length > 0, changedKeys };
}

/** 缓存与累积的重置策略:任何键变化 → 两者同时重置(单一布尔,不给部分重置留口子)。 */
export interface MaterialEvaluationReset {
  readonly resetEvaluationCache: boolean;
  readonly resetAccumulation: boolean;
  readonly reason: "parameter-change" | "unchanged";
}

export function materialEvaluationResetPolicy(change: MaterialParameterChange): MaterialEvaluationReset {
  return {
    resetEvaluationCache: change.changed,
    resetAccumulation: change.changed,
    reason: change.changed ? "parameter-change" : "unchanged",
  };
}

/** generation 合同:参数未变 generation 保持不变(重复提交不重置),变化则 +1。 */
export function nextMaterialEvaluationGeneration(generation: number, change: MaterialParameterChange): number {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new RangeError("Material evaluation generation must be a nonnegative safe integer.");
  }
  return change.changed ? generation + 1 : generation;
}
