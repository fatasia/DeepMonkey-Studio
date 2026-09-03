import type {
  RobotAssistantTargetInput,
  RobotCycleBudgetLine,
  RobotWorkcellAssistantInput,
} from "./robotWorkcellAssistantTypes";

/** UI 动作语义复用现有节拍合同的 process / settle，不扩展控制器指令。 */
export type RobotPathPointMode = "move" | Extract<RobotCycleBudgetLine["kind"], "process" | "settle"> | "process-settle";

export function isRobotPathPointEnabled(target: RobotAssistantTargetInput): boolean {
  return target.enabled !== false;
}

export function activeRobotPathTargets(input: Pick<RobotWorkcellAssistantInput, "targets">): RobotAssistantTargetInput[] {
  return input.targets.filter(isRobotPathPointEnabled);
}

export function robotPathPointMode(target: RobotAssistantTargetInput): RobotPathPointMode {
  const process = (target.processTimeSec ?? 0) > 0;
  const settle = (target.settleTimeSec ?? 0) > 0;
  return process && settle ? "process-settle" : process ? "process" : settle ? "settle" : "move";
}

export function changeRobotPathPointMode(target: RobotAssistantTargetInput, mode: RobotPathPointMode): RobotAssistantTargetInput {
  const next = { ...target };
  if (mode === "process" || mode === "process-settle") next.processTimeSec = positiveOrDefault(target.processTimeSec);
  else delete next.processTimeSec;
  if (mode === "settle" || mode === "process-settle") next.settleTimeSec = positiveOrDefault(target.settleTimeSec);
  else delete next.settleTimeSec;
  return next;
}

export function moveRobotPathPoint(targets: RobotAssistantTargetInput[], targetId: string, delta: -1 | 1): RobotAssistantTargetInput[] {
  const index = targets.findIndex((target) => target.id === targetId);
  const destination = index + delta;
  if (index < 0 || destination < 0 || destination >= targets.length) return targets;
  const next = targets.slice();
  const [moved] = next.splice(index, 1);
  next.splice(destination, 0, moved!);
  return next;
}

export function moveRobotPathPointBefore(targets: RobotAssistantTargetInput[], sourceId: string, destinationId: string): RobotAssistantTargetInput[] {
  if (sourceId === destinationId) return targets;
  const sourceIndex = targets.findIndex((target) => target.id === sourceId);
  if (sourceIndex < 0 || !targets.some((target) => target.id === destinationId)) return targets;
  const next = targets.slice();
  const [moved] = next.splice(sourceIndex, 1);
  const destinationIndex = next.findIndex((target) => target.id === destinationId);
  next.splice(destinationIndex, 0, moved!);
  return next;
}

function positiveOrDefault(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 1;
}
