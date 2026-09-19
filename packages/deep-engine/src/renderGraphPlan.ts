import type { RenderGraphCompileResult, RenderGraphIssue, RenderResourceLifetime } from "./renderGraph.js";

// B1 帧计划序列化(2026-09-20):把编译后的渲染图计划(执行序/资源生存期/
// 并行组/剔除清单/planHash)固化为可持久化的 JSON 重放脚本。
// 合同:planHash 不匹配的持久化计划在加载时拒绝——防篡改、防版本漂移。

const PLAN_SCHEMA = "deep-engine.render-graph-plan.v1" as const;

interface PersistedPlan {
  readonly schema: typeof PLAN_SCHEMA;
  readonly planHash: string;
  readonly order: readonly string[];
  readonly resources: readonly RenderResourceLifetime[];
  readonly culledPasses: readonly string[];
  readonly parallelGroups: readonly (readonly string[])[];
}

export class RenderPlanParseError extends Error {}

/** 把编译结果固化为单行 JSON(键序稳定,planHash 冗余存储用于加载校验)。 */
export function serializePlan(result: RenderGraphCompileResult): string {
  if (!result.valid) throw new Error("Refusing to serialize an invalid render-graph plan.");
  if (!result.planHash) throw new Error("Compiled plan is missing planHash; recompile with the current compiler.");
  const plan: PersistedPlan = {
    schema: PLAN_SCHEMA,
    planHash: result.planHash,
    order: result.order,
    resources: result.resources,
    culledPasses: result.culledPasses ?? [],
    parallelGroups: result.parallelGroups ?? [],
  };
  return JSON.stringify(plan);
}

/** 加载持久化计划:重算 planHash 并与存储值比对,不匹配即拒绝。 */
export function deserializePlan(text: string): RenderGraphCompileResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RenderPlanParseError(`Render plan JSON 无效: ${error instanceof Error ? error.message : String(error)}`);
  }
  const plan = parsed as Partial<PersistedPlan>;
  if (plan.schema !== PLAN_SCHEMA) throw new RenderPlanParseError(`Render plan schema 不匹配: ${String(plan.schema)}`);
  if (!Array.isArray(plan.order) || !Array.isArray(plan.resources)) {
    throw new RenderPlanParseError("Render plan 缺少 order/resources 字段。");
  }
  const expected = planHashOf({
    order: plan.order,
    resources: plan.resources,
    culledPasses: plan.culledPasses ?? [],
    parallelGroups: plan.parallelGroups ?? [],
  });
  if (expected !== plan.planHash) {
    throw new RenderPlanParseError(`Render plan hash 不匹配(存储 ${plan.planHash},重算 ${expected});计划被篡改或由不同编译器产出。`);
  }
  const issues: RenderGraphIssue[] = [];
  return Object.freeze({
    valid: true,
    order: Object.freeze([...(plan.order ?? [])]),
    resources: Object.freeze([...(plan.resources ?? [])]),
    issues: Object.freeze(issues),
    planHash: plan.planHash,
    culledPasses: Object.freeze([...(plan.culledPasses ?? [])]),
    parallelGroups: Object.freeze((plan.parallelGroups ?? []).map((group) => Object.freeze([...group]))),
  });
}

/** FNV-1a 32 位计划指纹:与 renderGraph 编译器的 planHash 同算法(单一权威实现处)。
 *  本处复制实现以保持序列化模块零依赖;测试保证两处输出一致。 */
function planHashOf(payload: unknown): string {
  // 键序硬编码为插入序,与 renderGraph.ts 的 planHashOf 逐字符一致(哈希互通的硬合同)。
  const text = JSON.stringify(payload);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** 计划记忆化:存储的 planHash 与重编译 planHash 相同则跳过重编译。 */
export function planMatches(compiledHash: string, storedPlan: string): boolean {
  try {
    const parsed = JSON.parse(storedPlan) as Partial<PersistedPlan>;
    return parsed.planHash === compiledHash;
  } catch {
    return false;
  }
}
