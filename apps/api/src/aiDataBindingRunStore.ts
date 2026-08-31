import type { AiDataBindingRunRecord } from "@bim-studio/contracts";

export const MAX_AI_DATA_BINDING_RUNS_PER_PROJECT = 500;

export function newestAiDataBindingRuns(records: readonly AiDataBindingRunRecord[]): AiDataBindingRunRecord[] {
  return [...records].sort((left, right) => {
    const createdOrder = right.createdAt.localeCompare(left.createdAt);
    return createdOrder || right.id.localeCompare(left.id);
  });
}

/** 运行历史属于轻量元数据；固定保留最近 500 条，避免项目文档无限增长。 */
export function retainRecentAiDataBindingRuns(records: readonly AiDataBindingRunRecord[]): AiDataBindingRunRecord[] {
  return newestAiDataBindingRuns(records).slice(0, MAX_AI_DATA_BINDING_RUNS_PER_PROJECT);
}
