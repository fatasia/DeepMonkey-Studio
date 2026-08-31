import type { Vector3Value } from "@bim-studio/contracts";
import type { RobotAssistantTargetInput, RobotCycleBudgetLine, RobotCycleBudgetResult, RobotWorkcellAssistantInput } from "./robotWorkcellAssistantTypes";

/** 节拍只给出运动学下界；不模拟加减速、奇异点、控制器圆滑、负载或 IO 抖动。 */
export function estimateRobotCycleBudget(input: RobotWorkcellAssistantInput): RobotCycleBudgetResult {
  const lines: RobotCycleBudgetLine[] = [];
  const tcpSpeed = input.cycleGoal.tcpSpeedMps;
  const jointSpeed = input.cycleGoal.jointSpeedDegPerSec;
  let previousPosition = input.robot.currentTcpPosition;
  let previousAngles = currentAngles(input);
  let estimatedMoves = 0;
  let expectedMoves = 0;

  for (const target of input.targets) {
    expectedMoves += 1;
    const cartesian = previousPosition && tcpSpeed ? distance(previousPosition, target.position) / tcpSpeed : undefined;
    const joint = previousAngles && target.jointAnglesDeg && jointSpeed ? jointMoveSeconds(previousAngles, target.jointAnglesDeg, jointSpeed) : undefined;
    const moveSeconds = maximumDefined(cartesian, joint);
    if (moveSeconds !== undefined) {
      estimatedMoves += 1;
      lines.push({
        id: `move:${target.id}`, label: `移动至 ${target.name}`,
        kind: joint !== undefined && joint >= (cartesian ?? 0) ? "joint-move" : "cartesian-move",
        seconds: round(moveSeconds),
        basis: joint !== undefined && joint >= (cartesian ?? 0) ? "最大关节角差 ÷ 关节速度" : "TCP 直线距离 ÷ TCP 速度",
      });
    }
    addTargetTimes(lines, target, input.cycleGoal.toolActionSec ?? 0);
    previousPosition = target.position;
    previousAngles = target.jointAnglesDeg;
  }
  const overhead = input.cycleGoal.controllerOverheadSec ?? 0;
  if (overhead > 0) lines.push({ id: "controller-overhead", label: "控制器与通信固定开销", kind: "controller", seconds: round(overhead), basis: "用户提供的固定预算" });
  const subtotal = sum(lines.map((item) => item.seconds));
  const margin = subtotal * (input.cycleGoal.safetyMarginPercent ?? 0) / 100;
  if (margin > 0) lines.push({ id: "safety-margin", label: "节拍裕量", kind: "margin", seconds: round(margin), basis: `${input.cycleGoal.safetyMarginPercent}% 用户裕量` });
  const motionAndProcessLowerBoundSec = round(subtotal);
  const plannedBudgetSec = round(subtotal + margin);
  const completeness = expectedMoves ? round(estimatedMoves / expectedMoves) : 0;
  const hasEstimate = input.targets.length > 0 && estimatedMoves > 0;
  const status = !hasEstimate ? "needs-data" : plannedBudgetSec > input.cycleGoal.targetSec ? "planned-budget-over-target" : "planned-budget-within-target";
  return {
    method: "kinematic-cycle-budget-v1", status, targetSec: input.cycleGoal.targetSec,
    ...(hasEstimate ? { motionAndProcessLowerBoundSec, plannedBudgetSec, slackSec: round(input.cycleGoal.targetSec - plannedBudgetSec) } : {}),
    completeness, lines,
    declaration: "运动与工艺时间采用直线距离/关节匀速下界，plannedBudget 叠加用户裕量；两者都不是控制器级节拍承诺，正式值需离线仿真或实机低速验证。",
  };
}

function addTargetTimes(lines: RobotCycleBudgetLine[], target: RobotAssistantTargetInput, toolActionSec: number): void {
  if ((target.processTimeSec ?? 0) > 0) lines.push({ id: `process:${target.id}`, label: `${target.name} 工艺时间`, kind: "process", seconds: round(target.processTimeSec!), basis: "用户提供的工艺时间" });
  if ((target.settleTimeSec ?? 0) > 0) lines.push({ id: `settle:${target.id}`, label: `${target.name} 稳定等待`, kind: "settle", seconds: round(target.settleTimeSec!), basis: "用户提供的稳定时间" });
  if (toolActionSec > 0) lines.push({ id: `tool:${target.id}`, label: `${target.name} 工具动作`, kind: "tool", seconds: round(toolActionSec), basis: "用户提供的工具动作预算" });
}

function currentAngles(input: RobotWorkcellAssistantInput): number[] | undefined {
  const values = input.robot.joints.map((item) => item.currentAngleDeg);
  return values.every((item): item is number => item !== undefined && Number.isFinite(item)) ? values : undefined;
}
function jointMoveSeconds(from: number[], to: number[], speed: number): number | undefined {
  if (from.length !== to.length || to.some((item) => !Number.isFinite(item))) return undefined;
  return Math.max(0, ...from.map((item, index) => Math.abs(to[index]! - item))) / speed;
}
function distance(left: Vector3Value, right: Vector3Value): number { return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z); }
function maximumDefined(...values: Array<number | undefined>): number | undefined { const finite = values.filter((item): item is number => item !== undefined && Number.isFinite(item)); return finite.length ? Math.max(...finite) : undefined; }
function sum(values: number[]): number { return values.reduce((total, value) => total + value, 0); }
function round(value: number): number { return Math.round(value * 1_000) / 1_000; }
