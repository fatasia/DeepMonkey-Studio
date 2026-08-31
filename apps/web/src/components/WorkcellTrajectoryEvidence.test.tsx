import type { WorkcellTrajectoryAnalysis } from "@bim-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkcellTrajectoryEvidence } from "./WorkcellTrajectoryEvidence";

describe("WorkcellTrajectoryEvidence", () => {
  it("shows approximation, precision, avoidance, schedule and cycle evidence without overclaiming", () => {
    const analysis: WorkcellTrajectoryAnalysis = {
      method: "piecewise-linear-tcp-sphere-aabb-v1",
      approximation: "conservative-broad-phase",
      declaration: "这是保守广相位，不是网格精确碰撞。",
      precisionStatus: "partial",
      jointChecks: [{
        trajectoryId: "path",
        waypointId: "end",
        jointId: "j1",
        angleDeg: 89.8,
        positionStatus: "tolerance-overlap",
        inboundSpeedDegPerSec: 10,
        speedStatus: "within-limit",
      }],
      segmentChecks: [{ trajectoryId: "path", segmentId: "path:0-1", startTimeSec: 0, endTimeSec: 4, lengthMeters: 2, potentialObstacleIds: ["guard"] }],
      avoidanceCandidates: [{ trajectoryId: "path", segmentId: "path:0-1", obstacleId: "guard", status: "candidate-found", waypoints: [], declaration: "待复核" }],
      scheduleConflicts: [],
      cycle: { trajectories: [], scheduleSpanSec: 4, maxConcurrentRobots: 1 },
    };
    const html = renderToStaticMarkup(<WorkcellTrajectoryEvidence analysis={analysis} />);

    expect(html).toContain("PS Lite 轨迹初筛");
    expect(html).toContain("精度部分声明");
    expect(html).toContain("1</b>潜在障碍");
    expect(html).toContain("1</b>避障候选");
    expect(html).toContain("1</b>关节约束风险");
    expect(html).toContain("1</b>最大并行机器人");
    expect(html).toContain("不是网格精确碰撞");
  });
});
