import type { AskDataQueryPlanInput } from "@bim-studio/contracts";
import { validateCapabilityValue } from "@bim-studio/plugin-runtime";
import { DATA_QUERY_SCHEMAS } from "./schemas.js";

export const ASK_DATA_DRAFT_INSTRUCTIONS = `你是工业数据查询计划助手。只返回一个 JSON 对象，不要 Markdown，不要 SQL。
对象必须符合给定的 AskDataQueryPlanInput：datasetId 和 fields 必填；只允许 filters、timeWindow、groupBy、aggregations、sort、limit。
只能引用目录中真实存在的数据集 ID 和字段 key，不能用字段 label 代替 key，不能猜测跨数据集关系。
优先返回最多 20 行的简洁统计。涉及平均、合计、最值或记录数时使用 aggregations；按设备、产线或时间类别比较时使用 groupBy。
用户没有说明时间范围时不要虚构；字段或意图不明确时仍选择最保守的单数据集方案，后续确定性校验会阻断无效计划。`;

export function parseAskDataQueryDraft(text: string): AskDataQueryPlanInput {
  if (!text.trim()) throw new Error("AI 未返回问数计划");
  if (text.length > 128 * 1024) throw new Error("AI 问数计划超过 128 KiB");
  let value: unknown;
  try { value = JSON.parse(stripFence(text.trim())); }
  catch { throw new Error("AI 问数计划不是有效 JSON"); }
  const normalized = normalizeLegacyAggregationFields(value);
  const issues = validateCapabilityValue(DATA_QUERY_SCHEMAS.plan.input, normalized);
  if (issues.length) throw new Error(`AI 问数计划不符合受限合同：${issues.slice(0, 5).join("；")}`);
  return normalized as AskDataQueryPlanInput;
}

/**
 * 部分兼容 OpenAI/Claude 常见的聚合命名，避免模型把正式合同中的
 * operator/as 写成 function/alias。兼容层仍会删除未知别名并再次走严格
 * schema 校验，不能绕过字段、类型或数据集检查。
 */
function normalizeLegacyAggregationFields(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const plan = value as Record<string, unknown>;
  if (!Array.isArray(plan.aggregations)) return value;
  return {
    ...plan,
    aggregations: plan.aggregations.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const aggregation = item as Record<string, unknown>;
      const normalized = { ...aggregation };
      if (normalized.operator === undefined && typeof normalized.function === "string") {
        normalized.operator = normalized.function;
      }
      if (normalized.as === undefined && typeof normalized.alias === "string") {
        normalized.as = normalized.alias;
      }
      delete normalized.function;
      delete normalized.alias;
      return normalized;
    }),
  };
}

function stripFence(value: string): string {
  return value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim() ?? value;
}
