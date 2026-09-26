// 多机器人信号互锁调度验证套件(emulated controller 层)。
// 业务约束:多机器人同步=信号互锁,操作默认带"结束信号"作迁移条件(PPS 深潜报告第 7 条);
// golden-sync 固值锁定双机握手全 timeline,数值或调度序任一变化都会使其失效,属预期破坏点。
import { describe, expect, it } from "vitest";
import { fingerprint64Labeled } from "@bim-studio/contracts";
import type { RobotProgramStep, RobotSyncProgram, RobotSyncResult, RobotSyncScenario } from "@bim-studio/contracts";
import { runRobotSyncScenario } from "./robotSync.js";

describe("多机器人信号互锁调度", () => {
  it("双机握手:R1 结束信号放行 R2,R2 结束信号放行 R1 下一站,周期=手算和", () => {
    const result = runRobotSyncScenario({
      scenarioId: "handshake",
      programs: [
        program("p1", "robot-1", [
          move("h1", "traj-a"),
          flag("h2", "r1-done"),
          gate("h3", "r2-done"),
          move("h4", "traj-b"),
        ]),
        program("p2", "robot-2", [
          gate("g1", "r1-done"),
          move("g2", "traj-c"),
          flag("g3", "r2-done"),
        ]),
      ],
      trajectoryDurations: { "traj-a": [1], "traj-b": [0.5], "traj-c": [2] },
    });

    expect(result.status).toBe("completed");
    // 手算和:1(R1 第一站)+ 2(R2 主站)+ 0.5(R1 第二站)= 3.5 s
    expect(result.cycleSeconds).toBeCloseTo(3.5, 9);
    expect(result.violations).toEqual([]);
    expect(pick(result, "signal-wait")).toEqual([
      { atSeconds: 0, programId: "p2", stepId: "g1" },
      { atSeconds: 1, programId: "p1", stepId: "h3" },
    ]);
    expect(pick(result, "signal-set")).toEqual([
      { atSeconds: 1, programId: "p1", stepId: "h2" },
      { atSeconds: 3, programId: "p2", stepId: "g3" },
    ]);
    expect(pick(result, "signal-acquired")).toEqual([
      { atSeconds: 1, programId: "p2", stepId: "g1" },
      { atSeconds: 3, programId: "p1", stepId: "h3" },
    ]);
    // R2 主站严格落在握手窗口 [1,3] 内,R1 第二站等 R2 结束后才启动
    expect(span(result, "p2", "g2")).toEqual([1, 3]);
    expect(span(result, "p1", "h4")[0]).toBeCloseTo(3, 9);
  });

  it("互等:双方都在等对方没有的信号 → deadlock,timeline 定位两机挂起步", () => {
    const result = runRobotSyncScenario({
      scenarioId: "mutual-wait",
      programs: [
        program("p1", "robot-1", [gate("d1", "go-1")]),
        program("p2", "robot-2", [gate("e1", "go-2")]),
      ],
    });

    expect(result.status).toBe("deadlock");
    expect(result.cycleSeconds).toBe(0);
    expect(result.violations).toEqual([]);
    expect(pick(result, "deadlocked")).toEqual([
      { atSeconds: 0, programId: "p1", stepId: "d1" },
      { atSeconds: 0, programId: "p2", stepId: "e1" },
    ]);
  });

  it("waitSignal 带超时:到期未成立 → signal-timeout,周期=挂起起点+超时时长", () => {
    const result = runRobotSyncScenario({
      scenarioId: "signal-timeout",
      programs: [
        program("p1", "robot-1", [move("t0", "lead"), gate("t1", "never", 3)]),
        // p2 只置位无关信号,"never" 保持 false,超时路径才可触发
        program("p2", "robot-2", [flag("u0", "unrelated")]),
      ],
      trajectoryDurations: { lead: [2] },
    });

    expect(result.status).toBe("signal-timeout");
    // p1 先执行 2 s 引导段后进入等待,3 s 超时在时刻 2+3=5 触发
    expect(result.cycleSeconds).toBeCloseTo(5, 9);
    expect(pick(result, "signal-timeout")).toEqual([{ atSeconds: 5, programId: "p1", stepId: "t1" }]);
  });

  it("TCP 活动窗口重叠:晚启动者记违规并整体推迟到先者结束,推迟后完成", () => {
    const result = runRobotSyncScenario({
      scenarioId: "tcp-clearance",
      clearMeters: 0.8,
      programs: [
        program("p1", "robot-1", [move("m1", "long")]),
        program("p2", "robot-2", [move("n1", "short"), pause("n2", 1)]),
      ],
      trajectoryDurations: { long: [4], short: [2] },
    });

    expect(result.status).toBe("completed");
    expect(result.violations).toEqual([
      { atSeconds: 0, kind: "tcp-clearance", programId: "p2", programIdOther: "p1" },
    ]);
    expect(span(result, "p1", "m1")).toEqual([0, 4]);
    // 晚启动者整体推迟到先者结束(4)再执行,后续步顺延
    expect(span(result, "p2", "n1")).toEqual([4, 6]);
    expect(span(result, "p2", "n2")).toEqual([6, 7]);
    expect(result.cycleSeconds).toBeCloseTo(7, 9);
    expect(pick(result, "deferred-clearance")).toEqual([{ atSeconds: 0, programId: "p2", stepId: "n1" }]);
  });

  it("非法场景显式拒绝:归属漂移与时长表缺键不得静默运行", () => {
    // 原始对象构造,绕过测试 helper 的归属自动回填
    expect(() => runRobotSyncScenario({
      scenarioId: "drift",
      programs: [{
        programId: "p1", robotStableId: "robot-1",
        steps: [{ stepId: "s1", robotStableId: "robot-2", durationSeconds: 1 }],
      }],
    })).toThrow(/漂移/);
    expect(() => runRobotSyncScenario({
      scenarioId: "missing-table",
      programs: [program("p1", "robot-1", [move("s1", "ghost")])],
      trajectoryDurations: {},
    })).toThrow(/时长/);
  });

  it("双跑逐位一致:结果深度相等且指纹相等", () => {
    const first = runRobotSyncScenario(goldenScenario());
    const second = runRobotSyncScenario(goldenScenario());
    expect(first).toEqual(second);
    expect(syncFingerprint(first)).toBe(syncFingerprint(second));
  });

  it("golden-sync:双机 8 步握手 scenario 全 timeline + 周期指纹锁定", () => {
    const result = runRobotSyncScenario(goldenScenario());

    expect(result.status).toBe("completed");
    expect(result.violations).toEqual([{
      atSeconds: 5, kind: "tcp-clearance", programId: "p1", programIdOther: "p2",
    }]);
    expect(result.cycleSeconds).toBeCloseTo(7.5, 9);
    expect(result.timeline).toHaveLength(15);
    expect(syncFingerprint(result)).toBe(GOLDEN_SYNC_FINGERPRINT);
    // 指纹对场景扰动敏感:改任一段时长必须换指纹
    const disturbed = runRobotSyncScenario({
      ...goldenScenario(),
      trajectoryDurations: { ...goldenScenario().trajectoryDurations!, "traj-2b": [1.6] },
    });
    expect(syncFingerprint(disturbed)).not.toBe(GOLDEN_SYNC_FINGERPRINT);
  });
});

/** golden-sync 固值:双机 8 步握手(含 5 s 处 p1 被 p2 活动窗口推迟)全 timeline 与周期的标签化指纹。 */
const GOLDEN_SYNC_FINGERPRINT = "4b38b8ab533ec133";

function syncFingerprint(result: RobotSyncResult): string {
  return fingerprint64Labeled([
    ["status", result.status],
    ["timeline", result.timeline],
    ["cycleSeconds", result.cycleSeconds],
    ["violations", result.violations],
  ]);
}

function pick(result: RobotSyncResult, event: string) {
  return result.timeline
    .filter((entry) => entry.event === event)
    .map((entry) => ({ atSeconds: entry.atSeconds, programId: entry.programId, stepId: entry.stepId }));
}

function span(result: RobotSyncResult, programId: string, stepId: string): [number, number] {
  // 只取活动窗口事件;deferred-clearance 记录的是被推迟时刻,不是步起点。
  const entries = result.timeline.filter((entry) =>
    entry.programId === programId && entry.stepId === stepId
    && (entry.event === "step-start" || entry.event === "step-complete"));
  return [entries[0]!.atSeconds, entries[entries.length - 1]!.atSeconds];
}

/** 双机 8 步 golden 场景:0.8 m 互斥监督下,R1 第二站在 5 s 处与 R2 收尾重叠被推迟。 */
function goldenScenario(): RobotSyncScenario {
  return {
    scenarioId: "golden-sync-handshake",
    clearMeters: 0.8,
    programs: [
      program("p1", "robot-1", [
        move("s1", "traj-1a"),
        flag("s2", "r1-done"),
        gate("s3", "r2-done"),
        move("s4", "traj-2b"),
      ]),
      program("p2", "robot-2", [
        gate("g1", "r1-done"),
        move("g2", "traj-2a"),
        flag("g3", "r2-done"),
        move("g4", "traj-2c"),
      ]),
    ],
    trajectoryDurations: { "traj-1a": [2], "traj-2a": [3], "traj-2b": [1.5], "traj-2c": [1] },
  };
}

function program(programId: string, robotStableId: string, steps: RobotProgramStep[]): RobotSyncProgram {
  return { programId, robotStableId, steps: steps.map((step) => ({ ...step, robotStableId })) };
}
function move(stepId: string, trajectoryRef: string): RobotProgramStep {
  return { stepId, robotStableId: "", trajectoryRef };
}
function flag(stepId: string, setSignal: string): RobotProgramStep {
  return { stepId, robotStableId: "", setSignal };
}
function gate(stepId: string, waitSignal: string, timeoutSeconds?: number): RobotProgramStep {
  return { stepId, robotStableId: "", waitSignal, ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}) };
}
function pause(stepId: string, durationSeconds: number): RobotProgramStep {
  return { stepId, robotStableId: "", durationSeconds };
}
