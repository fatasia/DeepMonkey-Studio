import type {
  RobotProgramStep,
  RobotSyncProgram,
  RobotSyncResult,
  RobotSyncScenario,
  RobotSyncTimelineEntry,
  RobotSyncViolation,
} from "@bim-studio/contracts";

interface SyncRunner {
  programId: string;
  steps: RobotProgramStep[];
  cursor: number;
  finishSeconds: number;
  /** 当前活动步的结束时刻;存在即机器人被占用,推进器跳过。 */
  activeEnd?: number;
  waitingSignal?: string;
  blockedSince?: number;
  done: boolean;
}

/**
 * emulated controller 层的事件驱动互锁仿真。
 * 业务约束:每 program 一个顺序游标;trajectory/duration 步独占机器人并登记活动窗口;
 * waitSignal 挂起直到中央信号表置位,setSignal 立即唤醒全部等待者;先声明的 program
 * 优先占用,晚启动者整体推迟到先者活动窗口结束——这是调度级互斥,不做连续空间
 * 避让,也不解算 TCP 几何距离;窗口重叠仅按"潜在过近"记录违规。
 */
export function runRobotSyncScenario(scenario: RobotSyncScenario): RobotSyncResult {
  const programs = validateScenario(scenario);
  const signals: Record<string, boolean> = { ...scenario.signals };
  const clearActive = scenario.clearMeters !== undefined
    && Number.isFinite(scenario.clearMeters)
    && (scenario.clearMeters as number) > 0;
  const timeline: RobotSyncTimelineEntry[] = [];
  const violations: RobotSyncViolation[] = [];
  const runners: SyncRunner[] = programs.map((program) => ({
    programId: program.programId,
    steps: program.steps,
    cursor: 0,
    finishSeconds: 0,
    done: false,
  }));
  const emit = (atSeconds: number, runner: SyncRunner, stepId: string, event: RobotSyncTimelineEntry["event"]) => {
    timeline.push({ atSeconds, programId: runner.programId, stepId, event });
  };

  /** 反复扫描全部 runner 直至无任何可立即推进的迁移。 */
  const advanceReady = (): boolean => {
    let progressed = false;
    let again = true;
    while (again) {
      again = false;
      for (const runner of runners) {
        if (runner.done) continue;
        if (advancedOnce(runner)) {
          progressed = true;
          again = true;
        }
      }
    }
    return progressed;
  };

  /** 对单个 runner 推进一个原子迁移;被阻塞(信号未成立/活动未到点)返回 false。 */
  const advancedOnce = (runner: SyncRunner): boolean => {
    // 到点活动:结算完成并迁移游标(complete 事件已在开始时登记)。
    if (runner.activeEnd !== undefined) {
      if (runner.activeEnd > now) return false;
      runner.finishSeconds = runner.activeEnd;
      delete runner.activeEnd;
      runner.cursor += 1;
      runner.done = runner.cursor >= runner.steps.length;
      return true;
    }
    if (runner.cursor >= runner.steps.length) {
      runner.done = true;
      return false;
    }
    const step = runner.steps[runner.cursor]!;
    if (runner.waitingSignal !== undefined) {
      // 挂起中信号仍未成立:保持等待。
      if (!signals[runner.waitingSignal]) return false;
      emit(now, runner, step.stepId, "signal-acquired");
      delete runner.waitingSignal;
      delete runner.blockedSince;
      // 不迁移游标:同一步的剩余动作(setSignal/活动)在本轮继续执行。
    } else if (step.waitSignal !== undefined && !signals[step.waitSignal]) {
      // 迁移条件不成立:进入挂起,等待信号表或超时唤醒。
      emit(now, runner, step.stepId, "signal-wait");
      runner.waitingSignal = step.waitSignal;
      runner.blockedSince = now;
      return true;
    }
    // 迁移条件已满足,执行步主体:先置位输出信号,再按步型占用或瞬时完成。
    if (step.setSignal !== undefined) {
      signals[step.setSignal] = true;
      emit(now, runner, step.stepId, "signal-set");
    }
    if (step.trajectoryRef !== undefined || step.durationSeconds !== undefined) {
      const start = deferForClearance(runner, step);
      const end = start + resolveDuration(step, scenario);
      emit(start, runner, step.stepId, "step-start");
      emit(end, runner, step.stepId, "step-complete");
      runner.activeEnd = end;
      return true;
    }
    runner.cursor += 1;
    runner.done = runner.cursor >= runner.steps.length;
    return true;
  };

  /** TCP 互斥:与在活动的其他 program 重叠即记违规,并把启动时刻推迟到最晚的先者结束。 */
  const deferForClearance = (runner: SyncRunner, step: RobotProgramStep): number => {
    let start = now;
    if (!clearActive) return start;
    for (const other of runners) {
      if (other === runner || other.activeEnd === undefined || start >= other.activeEnd) continue;
      violations.push({
        atSeconds: start,
        kind: "tcp-clearance",
        programId: runner.programId,
        programIdOther: other.programId,
      });
      emit(start, runner, step.stepId, "deferred-clearance");
      start = Math.max(start, other.activeEnd);
    }
    return start;
  };

  let now = 0;
  let status: RobotSyncResult["status"] = "completed";
  let settledAt = 0;
  advanceReady();
  for (;;) {
    if (runners.every((runner) => runner.done)) {
      settledAt = runners.reduce((latest, runner) => Math.max(latest, runner.finishSeconds), 0);
      break;
    }
    const candidates: number[] = [];
    for (const runner of runners) {
      if (runner.activeEnd !== undefined && runner.activeEnd > now) candidates.push(runner.activeEnd);
      if (runner.waitingSignal === undefined) continue;
      const timeout = runner.steps[runner.cursor]!.timeoutSeconds;
      if (timeout !== undefined) candidates.push(runner.blockedSince! + timeout);
    }
    if (!candidates.length) {
      const waiting = runners.filter((runner) => runner.waitingSignal !== undefined);
      if (!waiting.length) throw new Error(`场景 ${scenario.scenarioId} 进入未定义调度状态,请报告该场景`);
      for (const runner of waiting) emit(now, runner, runner.steps[runner.cursor]!.stepId, "deadlocked");
      status = "deadlock";
      settledAt = now;
      break;
    }
    now = Math.min(...candidates);
    const timedOut = runners.filter((runner) => {
      if (runner.waitingSignal === undefined) return false;
      const timeout = runner.steps[runner.cursor]!.timeoutSeconds;
      return timeout !== undefined && now >= runner.blockedSince! + timeout;
    });
    if (timedOut.length) {
      for (const runner of timedOut) emit(now, runner, runner.steps[runner.cursor]!.stepId, "signal-timeout");
      status = "signal-timeout";
      settledAt = now;
      break;
    }
    advanceReady();
  }

  timeline.sort((left, right) => left.atSeconds - right.atSeconds);
  return { status, timeline, cycleSeconds: settledAt, violations };
}

function validateScenario(scenario: RobotSyncScenario): RobotSyncProgram[] {
  if (scenario.clearMeters !== undefined && (!Number.isFinite(scenario.clearMeters) || scenario.clearMeters < 0))
    throw new Error(`场景 ${scenario.scenarioId} 的 clearMeters 必须是非负有限值`);
  const programIds = new Set<string>();
  for (const program of scenario.programs) {
    if (programIds.has(program.programId)) throw new Error(`场景 ${scenario.scenarioId} 中 programId ${program.programId} 重复`);
    programIds.add(program.programId);
    const stepIds = new Set<string>();
    for (const step of program.steps) {
      if (step.robotStableId !== program.robotStableId)
        throw new Error(`program ${program.programId} 的步骤 ${step.stepId} 归属 ${step.robotStableId} 与程序机器人 ${program.robotStableId} 漂移`);
      if (stepIds.has(step.stepId)) throw new Error(`program ${program.programId} 中 stepId ${step.stepId} 重复`);
      stepIds.add(step.stepId);
      if (step.waitSignal !== undefined && step.timeoutSeconds !== undefined
        && (!Number.isFinite(step.timeoutSeconds) || step.timeoutSeconds < 0))
        throw new Error(`步骤 ${step.stepId} 的 timeoutSeconds 必须是非负有限值`);
    }
  }
  return scenario.programs;
}

function resolveDuration(step: RobotProgramStep, scenario: RobotSyncScenario): number {
  const raw = step.durationSeconds !== undefined
    ? step.durationSeconds
    : scenario.trajectoryDurations?.[step.trajectoryRef!]?.reduce((total, value) => total + value, 0);
  if (raw === undefined || !Number.isFinite(raw) || raw < 0)
    throw new Error(`步骤 ${step.stepId} 无法解析活动时长:缺 durationSeconds 或时长表缺少轨迹 ${step.trajectoryRef}`);
  return raw;
}
