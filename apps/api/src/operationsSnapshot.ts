import type { PlantLiteStudyRecord } from "@bim-studio/contracts";

/**
 * `/operations` 是工作台首屏快照，不是历史轨迹归档接口。
 * UI 只回放最新一次运行，因此列表响应最多携带一条完整轨迹。
 */
export const OPERATIONS_SNAPSHOT_PLANT_LITE_TRACE_BUDGET = 1;

export function plantLiteStudiesForOperationsSnapshot(
  studies: PlantLiteStudyRecord[],
): PlantLiteStudyRecord[] {
  return studies.map((study, index) => {
    if (index < OPERATIONS_SNAPSHOT_PLANT_LITE_TRACE_BUDGET || !study.trace) return study;
    const { trace: _omittedHistoricalTrace, ...summary } = study;
    return summary;
  });
}
