import type { WorkcellTrajectoryAnalysis } from "@bim-studio/contracts";
import { Route } from "lucide-react";

export function WorkcellTrajectoryEvidence({ analysis }: { analysis: WorkcellTrajectoryAnalysis }) {
  const potential = analysis.segmentChecks.reduce((total, item) => total + item.potentialObstacleIds.length, 0);
  const candidates = analysis.avoidanceCandidates.filter((item) => item.status === "candidate-found").length;
  const jointRisks = analysis.jointChecks.filter((item) =>
    item.positionStatus === "outside-limit"
    || item.positionStatus === "tolerance-overlap"
    || item.speedStatus === "outside-limit"
    || item.speedStatus === "tolerance-overlap").length;
  return <div className="workcell-trajectory-evidence">
    <header>
      <span><Route size={13} /><strong>PS Lite 轨迹初筛</strong></span>
      <em>{precisionLabel(analysis.precisionStatus)}</em>
    </header>
    <div>
      <span><b>{potential}</b>潜在障碍</span>
      <span><b>{candidates}</b>避障候选</span>
      <span><b>{jointRisks}</b>关节约束风险</span>
      <span><b>{analysis.scheduleConflicts.length}</b>时段冲突</span>
      <span><b>{analysis.cycle.maxConcurrentRobots}</b>最大并行机器人</span>
      <span><b>{analysis.cycle.scheduleSpanSec.toFixed(1)}s</b>排程跨度</span>
    </div>
    <p>{analysis.declaration}</p>
  </div>;
}

function precisionLabel(value: WorkcellTrajectoryAnalysis["precisionStatus"]): string {
  return ({ declared: "精度已声明", partial: "精度部分声明", undeclared: "精度未声明" })[value];
}
