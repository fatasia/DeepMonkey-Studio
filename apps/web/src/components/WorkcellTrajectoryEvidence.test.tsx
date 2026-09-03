import type { WorkcellRobotTrajectory, WorkcellTrajectoryAnalysis } from "@bim-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkcellTrajectoryEvidence } from "./WorkcellTrajectoryEvidence";

describe("WorkcellTrajectoryEvidence", () => {
  it("shows approximation, precision, avoidance, schedule and cycle evidence without overclaiming", () => {
    const analysis = analysisFixture();
    const html = renderToStaticMarkup(<WorkcellTrajectoryEvidence analysis={analysis} />);

    expect(html).toContain("机器人轨迹快速初筛");
    expect(html).toContain("精度部分声明");
    expect(html).toContain("1</b>潜在障碍");
    expect(html).toContain("1</b>避障候选");
    expect(html).toContain("1</b>关节约束风险");
    expect(html).toContain("1</b>最大并行机器人");
    expect(html).toContain("不是网格精确碰撞");
    expect(html).toContain("交付包不可用");
    expect(html).toContain("aria-describedby");
    expect(html).toContain("缺少与分析匹配的轨迹输入：path");
    expect(html).toContain("当前结果不能回放");
  });

  it("renders real timeline controls, evidence markers and the static-viewer boundary", () => {
    const trajectory: WorkcellRobotTrajectory = {
      id: "path", name: "机器人取放候选", robotId: "robot-1",
      waypoints: [
        { id: "start", timeSec: 0, position: { x: 0, y: 0, z: 0 }, jointAnglesDeg: [49.8] },
        { id: "end", timeSec: 4, position: { x: 2, y: 0, z: 0 }, jointAnglesDeg: [89.8] },
      ],
    };
    const html = renderToStaticMarkup(<WorkcellTrajectoryEvidence analysis={analysisFixture()} trajectories={[trajectory]} onOpenObject={() => undefined} />);

    expect(html).toContain("机器人取放候选");
    expect(html).toContain("播放");
    expect(html).toContain("0.5x");
    expect(html).toContain("1x");
    expect(html).toContain("2x");
    expect(html).toContain("轨迹时间轴");
    expect(html).toContain("潜在障碍");
    expect(html).toContain("定位机器人");
    expect(html).toContain("定位 guard");
    expect(html).toContain("j1 接近约束");
    expect(html).toContain("1 条轨迹 · 2 帧");
    expect(html).toContain("交付包");
    expect(html).toContain("关键帧");
    expect(html).toContain("尚不驱动机器人骨骼");
    expect(html).not.toContain("精确轨迹回放");
  });
});

function analysisFixture(): WorkcellTrajectoryAnalysis {
  return {
    method: "piecewise-linear-tcp-sphere-aabb-v1",
    approximation: "conservative-broad-phase",
    declaration: "这是保守广相位，不是网格精确碰撞。",
    precisionStatus: "partial",
    jointChecks: [{
      trajectoryId: "path", waypointId: "end", jointId: "j1", angleDeg: 89.8,
      positionStatus: "tolerance-overlap", inboundSpeedDegPerSec: 10, speedStatus: "within-limit",
    }],
    segmentChecks: [{ trajectoryId: "path", segmentId: "path:0-1", startTimeSec: 0, endTimeSec: 4, lengthMeters: 2, potentialObstacleIds: ["guard"] }],
    avoidanceCandidates: [{ trajectoryId: "path", segmentId: "path:0-1", obstacleId: "guard", status: "candidate-found", waypoints: [], declaration: "待复核" }],
    scheduleConflicts: [],
    cycle: {
      trajectories: [{ trajectoryId: "path", robotId: "robot-1", durationSec: 4, pathLengthMeters: 2, averageTcpSpeedMps: .5 }],
      scheduleSpanSec: 4,
      maxConcurrentRobots: 1,
    },
  };
}
