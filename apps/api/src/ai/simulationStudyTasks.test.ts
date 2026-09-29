import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AiHypothesisContract, AiVerificationEnvelope } from "@bim-studio/contracts";
import {
  aiHypothesisProposalFingerprint,
  validateAiHypothesisContract,
  validateAiVerificationEnvelope,
} from "@bim-studio/contracts";
import type { CapabilityProvider } from "@bim-studio/plugin-runtime";
import { ProvenanceLedgerStore } from "./provenanceLedger.js";
import { createGoldenVerifyProvider, goldenVerifyInputFingerprint } from "./simulationHypothesisPlugin.js";
import {
  SimulationStudyTaskError,
  SimulationStudyTaskStore,
  STUDY_MAX_REPEATS,
  type SimulationStudyTaskView,
} from "./simulationStudyTasks.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await new Promise((resolve) => setTimeout(resolve, 20));
});

const POSITIVE_HYPOTHESIS: AiHypothesisContract = {
  hypothesisVersion: "1",
  id: "hyp-study-async-1",
  statement: "校准场景中传感器单元利用率低于 0.3",
  targetModel: "t23-conveyor-sensor-agv",
  prediction: { metric: "resource-utilization", resourceId: "sensor-unit", comparator: "less-than", expected: 0.3 },
  tolerance: { absolute: 0.05 },
};

interface TestEnv {
  directory: string;
  ledger: ProvenanceLedgerStore;
  tasks: SimulationStudyTaskStore;
}

async function buildEnv(options: {
  stepDelayMs?: number;
  maxRunningPerProject?: number;
  /** 注入替代 golden provider（inconclusive 数据缺口等口径的 stub）。 */
  goldenProvider?: CapabilityProvider<{ hypothesis: unknown }>;
  /** 注入账本 settle 写失败（收口诚实性口径）。 */
  breakLedgerSettle?: boolean;
} = {}): Promise<TestEnv> {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-study-tasks-"));
  const ledger = new ProvenanceLedgerStore(directory);
  await ledger.init();
  const tasks = new SimulationStudyTaskStore(directory, {
    ledger: options.breakLedgerSettle ? failingSettleLedger(ledger) : ledger,
    // 任务内部 provider 不带账本：完成收口由 recordStudySettled 一次性幂等落账（与生产装配同口径）。
    goldenProvider: options.goldenProvider ?? createGoldenVerifyProvider(),
    ...(options.stepDelayMs !== undefined ? { stepDelayMs: options.stepDelayMs } : {}),
    ...(options.maxRunningPerProject !== undefined ? { maxRunningPerProject: options.maxRunningPerProject } : {}),
  });
  await tasks.init();
  cleanups.push(async () => {
    tasks.dispose();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, ledger, tasks };
}

/**
 * 只在 recordStudySettled 上注入失败的账本委托：其余方法转发真实账本（this 绑定真实实例，
 * 私有字段访问不受影响），用于验证"账本故障不推翻收口、warning 如实上浮"。
 */
function failingSettleLedger(ledger: ProvenanceLedgerStore): ProvenanceLedgerStore {
  const delegated = [
    "init",
    "recordHypothesis",
    "recordVerification",
    "recordReport",
    "recordStudyLaunched",
    "recordStudyHalted",
    "listStudyRuns",
    "trace",
    "listChains",
    "chainByResult",
  ] as const;
  const wrapper: Record<string, unknown> = {};
  for (const key of delegated) {
    wrapper[key] = (...args: unknown[]) =>
      (ledger as unknown as Record<string, (...methodArgs: unknown[]) => unknown>)[key](...args);
  }
  wrapper.recordStudySettled = async (): Promise<never> => {
    throw new Error("模拟账本写失败（测试注入）");
  };
  return wrapper as unknown as ProvenanceLedgerStore;
}

/** 构建通过出边界合同自检的 inconclusive 信封（数据缺口口径：metric-unavailable）。 */
function buildInconclusiveEnvelope(contract: AiHypothesisContract, resultFingerprint: string): AiVerificationEnvelope {
  return validateAiVerificationEnvelope({
    proposalFingerprint: aiHypothesisProposalFingerprint(contract),
    inputFingerprint: goldenVerifyInputFingerprint(contract.targetModel),
    resultFingerprint,
    verdict: "inconclusive",
    tolerance: contract.tolerance,
    reasonCode: "metric-unavailable",
    rationale: "目标场景未提供可观测指标，无法裁决（数据缺口如实入理由）。",
    generatedAt: new Date().toISOString(),
    evidence: [],
  });
}

/** 数据缺口 stub：每次执行都返回同一 inconclusive 信封（确定性研究口径，同输入同指纹）。 */
function createInconclusiveGoldenProvider(resultFingerprint: string): CapabilityProvider<{ hypothesis: unknown }> {
  return {
    descriptor: {
      id: "golden.inconclusive-stub",
      version: "1.0.0",
      label: "数据缺口 stub（inconclusive）",
      kind: "analysis",
      execution: "in-process",
      permissions: [],
      timeoutMs: 1_000,
      inputSchemaVersion: "1.0",
      outputSchemaVersion: "1.0",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    },
    async invoke(request) {
      const contract = validateAiHypothesisContract((request.input as { hypothesis: unknown }).hypothesis);
      return {
        status: "completed",
        decisionStatus: "research-candidate",
        output: buildInconclusiveEnvelope(contract, resultFingerprint),
      };
    },
  };
}

async function waitFor(
  tasks: SimulationStudyTaskStore,
  taskId: string,
  predicate: (view: SimulationStudyTaskView) => boolean,
  timeoutMs = 15_000,
): Promise<SimulationStudyTaskView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await tasks.status("project-1", taskId);
    if (view && predicate(view)) return view;
    if (Date.now() > deadline) throw new Error(`轮询超时：taskId=${taskId}，最后状态=${JSON.stringify(view)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** H-C3 后续切片验收：发起→轮询→完成全链 + 账本幂等收口 + 断线恢复同指纹。 */
describe("SimulationStudyTaskStore（异步长跑）", () => {
  it("发起即返回 durable 句柄（running），轮询至完成，信封/指纹齐备，账本运行段收口移除", async () => {
    const { ledger, tasks } = await buildEnv();
    const launched = await tasks.launch("project-1", "tester:1", { hypothesis: POSITIVE_HYPOTHESIS, budget: { repeats: 2 } });
    expect(launched.taskId).toMatch(/^study-[0-9a-f]{16}$/);
    expect(launched.status).toBe("running");
    expect(launched.proposalFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(launched.budget).toEqual({ repeats: 2, wallClockMs: 120_000 });

    const view = await waitFor(tasks, launched.taskId, (item) => item.status === "completed");
    expect(view.status).toBe("completed");
    expect(view.partial).toBe(false);
    expect(view.progress).toEqual({ completedRepeats: 2, totalRepeats: 2 });
    expect(view.envelope?.verdict).toBe("confirmed");
    expect(view.resultFingerprint).toBe(view.envelope?.resultFingerprint);
    // 证据最小化：轮询视图不下发提交者 principal。
    expect(view.principal === undefined).toBe(true);

    // 账本：完成收口后运行段记录移除，三跳链由真实 run/verdict 节点构成且完整。
    expect(await ledger.listStudyRuns("project-1")).toEqual([]);
    const trace = await ledger.trace("project-1", { resultFingerprint: view.resultFingerprint! });
    expect(trace.matched).toBe(true);
    expect(trace.chains).toHaveLength(1);
    expect(trace.chains[0].runs).toHaveLength(1);
    expect(trace.chains[0].verdicts.map((node) => node.verdict)).toEqual(["confirmed"]);
    expect(trace.chains[0].integrity).toBe("intact");
    expect(trace.chains[0].hypothesis.hypothesisId).toBe("hyp-study-async-1");
  }, 20_000);

  it("发起即落账本'进行中链'（假设节点+运行中记录），取消后保留取消态且不伪造判定", async () => {
    const { ledger, tasks } = await buildEnv({ stepDelayMs: 15 });
    const launched = await tasks.launch("project-1", "tester:1", { hypothesis: POSITIVE_HYPOTHESIS, budget: { repeats: 200 } });

    const runningRecords = await ledger.listStudyRuns("project-1", { status: "running" });
    expect(runningRecords).toHaveLength(1);
    expect(runningRecords[0]).toMatchObject({ kind: "study-run", nodeId: launched.taskId, status: "running" });
    // 进行中链：三跳 trace 如实呈现"只登记未验证"（假设在、运行段为空、无伪造判定）。
    const inFlight = await ledger.trace("project-1", { proposalFingerprint: launched.proposalFingerprint });
    expect(inFlight.matched).toBe(true);
    expect(inFlight.chains[0].runs).toHaveLength(0);
    expect(inFlight.chains[0].verdicts).toHaveLength(0);

    await waitFor(tasks, launched.taskId, (item) => item.progress.completedRepeats >= 1);
    const cancelled = await tasks.cancel("project-1", launched.taskId, { principal: "tester:1" });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.settleReason).toBe("user");
    expect(cancelled.partial).toBe(true);
    expect(cancelled.envelope).toBeUndefined();
    expect(cancelled.progress.completedRepeats).toBeGreaterThanOrEqual(1);

    // 取消态在账本如实保留（不伪造成 completed、不产生判定节点）。
    const halted = await ledger.listStudyRuns("project-1");
    expect(halted).toHaveLength(1);
    expect(halted[0].status).toBe("cancelled");
    expect(halted[0].settleReason).toBe("user");
    expect(halted[0].completedRepeats).toBe(cancelled.progress.completedRepeats);
    const trace = await ledger.trace("project-1", { proposalFingerprint: launched.proposalFingerprint });
    expect(trace.chains[0].runs).toHaveLength(0);
    expect(trace.chains[0].verdicts).toHaveLength(0);
  }, 20_000);

  it("超预算 fail-closed 取消：budget-exceeded 如实标注且保留部分证据", async () => {
    const { ledger, tasks } = await buildEnv({ stepDelayMs: 25 });
    const launched = await tasks.launch("project-1", "tester:1", { hypothesis: POSITIVE_HYPOTHESIS, budget: { repeats: 5_000, wallClockMs: 1_000 } });
    const view = await waitFor(tasks, launched.taskId, (item) => item.status !== "running");
    expect(view.status).toBe("cancelled");
    expect(view.settleReason).toBe("budget-exceeded");
    expect(view.partial).toBe(true);
    expect(view.warnings.join("\n")).toContain("预算");
    expect(view.envelope).toBeUndefined();
    const halted = await ledger.listStudyRuns("project-1");
    expect(halted[0].status).toBe("cancelled");
    expect(halted[0].settleReason).toBe("budget-exceeded");
  }, 20_000);

  it("断线恢复（dispose 模拟进程死亡 → 新存储重启）：同指纹续写，账本链不重复", async () => {
    const first = await buildEnv({ stepDelayMs: 5 });
    // 参照指纹：同一确定性研究同步直调一次（与 golden.verify 同一 provider/合同）。
    const golden = createGoldenVerifyProvider(first.ledger);
    const reference = await golden.invoke(
      { requestId: "ref-1", projectId: "project-1", principal: "tester:1", input: { hypothesis: POSITIVE_HYPOTHESIS } },
      { pluginId: "test", pluginVersion: "1.0.0", descriptor: golden.descriptor, signal: new AbortController().signal },
    );
    expect(reference.status).toBe("completed");
    const referenceFingerprint = (reference.output as { resultFingerprint: string }).resultFingerprint;

    const launched = await first.tasks.launch("project-1", "tester:1", { hypothesis: POSITIVE_HYPOTHESIS, budget: { repeats: 3 } });
    expect(first.tasks.dispose()).toBe(1);
    const onDisk = JSON.parse(await readFile(path.join(first.directory, "simulation-study-tasks", "project-1", "tasks.json"), "utf8")) as {
      tasks: Array<{ taskId: string; status: string }>;
    };
    expect(onDisk.tasks.find((item) => item.taskId === launched.taskId)?.status).toBe("running");

    // 新宿主重启：同目录新账本+新任务存储 → init 恢复 → 同指纹完成，链不重复。
    const resumedLedger = new ProvenanceLedgerStore(first.directory);
    await resumedLedger.init();
    const resumedTasks = new SimulationStudyTaskStore(first.directory, {
      ledger: resumedLedger,
      goldenProvider: createGoldenVerifyProvider(resumedLedger),
      stepDelayMs: 5,
    });
    await resumedTasks.init();
    const view = await waitFor(resumedTasks, launched.taskId, (item) => item.status === "completed");
    expect(view.resultFingerprint).toBe(referenceFingerprint);
    expect(view.warnings).toContain("resumed-after-restart");
    expect(view.envelope?.verdict).toBe("confirmed");

    // 同步参照运行 + 恢复运行两次落账：同 resultFingerprint 幂等续写，链仍只有一次运行一个判定。
    const trace = await resumedLedger.trace("project-1", { resultFingerprint: referenceFingerprint });
    expect(trace.matched).toBe(true);
    expect(trace.chains).toHaveLength(1);
    expect(trace.chains[0].runs).toHaveLength(1);
    expect(trace.chains[0].verdicts).toHaveLength(1);
    expect(trace.chains[0].integrity).toBe("intact");
    expect(await resumedLedger.listStudyRuns("project-1")).toEqual([]);
    resumedTasks.dispose();
  }, 20_000);

  it("预算钳制 fail-closed：repeats/wallClock 越界即收口为上限值", async () => {
    const { tasks } = await buildEnv();
    const launched = await tasks.launch("project-1", "tester:1", {
      hypothesis: POSITIVE_HYPOTHESIS,
      budget: { repeats: STUDY_MAX_REPEATS * 10, wallClockMs: 1 },
    });
    expect(launched.budget.repeats).toBe(STUDY_MAX_REPEATS);
    expect(launched.budget.wallClockMs).toBe(1_000);
    const cancelled = await tasks.cancel("project-1", launched.taskId, { principal: "tester:1" });
    expect(cancelled.status).toBe("cancelled");
  }, 20_000);

  it("并发闸：超出每项目上限 fail-closed 拒绝，取消后可再发起；被拒任务不留账本孤儿", async () => {
    const { ledger, tasks } = await buildEnv({ stepDelayMs: 15, maxRunningPerProject: 1 });
    const first = await tasks.launch("project-1", "tester:1", { hypothesis: POSITIVE_HYPOTHESIS, budget: { repeats: 500 } });
    await expect(tasks.launch("project-1", "tester:1", { hypothesis: POSITIVE_HYPOTHESIS })).rejects.toMatchObject({ code: "concurrency-cap" });
    expect(await ledger.listStudyRuns("project-1", { status: "running" })).toHaveLength(1);
    await tasks.cancel("project-1", first.taskId, { principal: "tester:1" });
    const second = await tasks.launch("project-1", "tester:1", { hypothesis: POSITIVE_HYPOTHESIS, budget: { repeats: 1 } });
    await waitFor(tasks, second.taskId, (item) => item.status === "completed");
  }, 20_000);

  it("取消权：非提交者拒绝，admin 可取消；完成态取消不生效（如实拒绝）", async () => {
    const { tasks } = await buildEnv({ stepDelayMs: 15 });
    const launched = await tasks.launch("project-1", "user-a:1", { hypothesis: POSITIVE_HYPOTHESIS, budget: { repeats: 500 } });
    await expect(tasks.cancel("project-1", launched.taskId, { principal: "user-b:2" })).rejects.toMatchObject({ code: "task-not-owner" });
    await expect(tasks.cancel("project-1", launched.taskId, { principal: "user-b:2", role: "admin" })).resolves.toMatchObject({ status: "cancelled" });

    const finished = await tasks.launch("project-1", "user-a:1", { hypothesis: POSITIVE_HYPOTHESIS, budget: { repeats: 1 } });
    await waitFor(tasks, finished.taskId, (item) => item.status === "completed");
    await expect(tasks.cancel("project-1", finished.taskId, { principal: "user-a:1" })).rejects.toMatchObject({ code: "task-already-completed" });
  }, 20_000);

  it("串行提交纪律回归：并发发起/取消/轮询交错，落盘文档零损坏且全部任务一致", async () => {
    const { directory, ledger, tasks } = await buildEnv({ stepDelayMs: 5, maxRunningPerProject: 3 });
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () => tasks.launch("project-1", "tester:1", { hypothesis: POSITIVE_HYPOTHESIS, budget: { repeats: 2 } })),
    );
    const fulfilled = attempts.filter((item): item is PromiseFulfilledResult<{ taskId: string }> => item.status === "fulfilled");
    const rejected = attempts.filter((item) => item.status === "rejected");
    expect(fulfilled).toHaveLength(3);
    for (const item of rejected) {
      expect((item as PromiseRejectedResult).reason).toBeInstanceOf(SimulationStudyTaskError);
      expect((item as PromiseRejectedResult).reason).toMatchObject({ code: "concurrency-cap" });
    }
    // 与运行循环的步进提交并发交错的读/取消操作：串行化提交保证不撕裂文档。
    await Promise.allSettled([
      ...fulfilled.map((item) => tasks.status("project-1", item.value.taskId)),
      tasks.cancel("project-1", fulfilled[0].value.taskId, { principal: "tester:1" }),
      ledger.listStudyRuns("project-1"),
      ledger.trace("project-1", {}),
    ]);
    for (const item of fulfilled.slice(1)) {
      const view = await waitFor(tasks, item.value.taskId, (state) => state.status === "completed");
      expect(view.envelope?.verdict).toBe("confirmed");
    }
    const document = JSON.parse(await readFile(path.join(directory, "simulation-study-tasks", "project-1", "tasks.json"), "utf8")) as {
      schemaVersion: number;
      tasks: Array<{ taskId: string; status: string }>;
    };
    expect(document.schemaVersion).toBe(1);
    expect(document.tasks).toHaveLength(3);
    const statuses = document.tasks.map((item) => item.status).sort();
    expect(statuses).toEqual(["cancelled", "completed", "completed"]);
  }, 20_000);

  it("未知/非法句柄如实未命中：status 返回 undefined，cancel 报 task-not-found/invalid-task-id", async () => {
    const { tasks } = await buildEnv();
    expect(await tasks.status("project-1", "study-0000000000000000")).toBeUndefined();
    await expect(tasks.cancel("project-1", "study-0000000000000000", { principal: "tester:1" })).rejects.toMatchObject({ code: "task-not-found" });
    await expect(tasks.status("project-1", "not-a-handle")).rejects.toMatchObject({ code: "invalid-task-id" });
    await expect(tasks.launch("project-1", "tester:1", { hypothesis: { hypothesisVersion: "9" } })).rejects.toMatchObject({ code: "invalid-hypothesis" });
  }, 20_000);

  it("账本落盘形状：运行段记录进入 ledger.json（进行中链可断线核查），无提示词原文", async () => {
    const first = await buildEnv({ stepDelayMs: 30 });
    const launched = await first.tasks.launch("project-1", "tester:1", { hypothesis: POSITIVE_HYPOTHESIS, budget: { repeats: 500 } });
    const raw = JSON.parse(await readFile(path.join(first.directory, "provenance-ledger", "project-1", "ledger.json"), "utf8")) as {
      studyRuns: Array<{ kind: string; nodeId: string; status: string; statement?: string }>;
      hypotheses: Array<{ statementDigest: string; statement?: string }>;
    };
    expect(raw.studyRuns).toHaveLength(1);
    expect(raw.studyRuns[0]).toMatchObject({ kind: "study-run", nodeId: launched.taskId, status: "running" });
    for (const hypothesis of raw.hypotheses) {
      expect(hypothesis.statement).toBeUndefined();
      expect(typeof hypothesis.statementDigest).toBe("string");
    }
    await first.tasks.cancel("project-1", launched.taskId, { principal: "tester:1" });
    const halted = JSON.parse(await readFile(path.join(first.directory, "provenance-ledger", "project-1", "ledger.json"), "utf8")) as {
      studyRuns: Array<{ status: string; settleReason?: string }>;
    };
    expect(halted.studyRuns[0]).toMatchObject({ status: "cancelled", settleReason: "user" });
  }, 20_000);

  // ---------------------------------------------------------------------------
  // H-A3 验收切片（MCP Tasks 异步长跑）：数据缺口如实进 inconclusive 理由、
  // 恢复不变量、轮询可见性与收口诚实性。不新立任务系统，只补既有面的验收缺口。
  // ---------------------------------------------------------------------------

  it("数据缺口如实 inconclusive：verdict/reasonCode 进轮询、账本判定节点与 trace 三跳，不伪造 confirmed", async () => {
    const resultFingerprint = randomBytes(8).toString("hex");
    const { ledger, tasks } = await buildEnv({ goldenProvider: createInconclusiveGoldenProvider(resultFingerprint) });
    const launched = await tasks.launch("project-1", "tester:1", { hypothesis: POSITIVE_HYPOTHESIS, budget: { repeats: 2 } });

    // 轮询视图：inconclusive 与理由码如实透出，不升格为 confirmed。
    const view = await waitFor(tasks, launched.taskId, (item) => item.status === "completed");
    expect(view.envelope?.verdict).toBe("inconclusive");
    expect(view.envelope?.reasonCode).toBe("metric-unavailable");
    expect(view.resultFingerprint).toBe(resultFingerprint);
    expect(view.warnings.join("\n")).not.toContain("confirmed");

    // 账本：三跳链完整、判定节点携带同一理由码、完整性 intact、运行段已收口。
    const trace = await ledger.trace("project-1", { resultFingerprint });
    expect(trace.matched).toBe(true);
    expect(trace.chains).toHaveLength(1);
    expect(trace.chains[0].hypothesis.hypothesisId).toBe("hyp-study-async-1");
    expect(trace.chains[0].runs).toHaveLength(1);
    expect(trace.chains[0].verdicts).toHaveLength(1);
    expect(trace.chains[0].verdicts[0]).toMatchObject({ verdict: "inconclusive", reasonCode: "metric-unavailable" });
    expect(trace.chains[0].integrity).toBe("intact");
    expect(await ledger.listStudyRuns("project-1")).toEqual([]);
  }, 20_000);

  it("provider 数据缺口阻断：语义预检拒绝 → 任务 failed（provider-blocked），理由如实入任务与账本，不伪造判定", async () => {
    const { ledger, tasks } = await buildEnv();
    const blocked = await tasks.launch("project-1", "tester:1", {
      hypothesis: {
        ...POSITIVE_HYPOTHESIS,
        id: "hyp-study-admission",
        prediction: { ...POSITIVE_HYPOTHESIS.prediction, resourceId: "not-in-scene" },
      },
      budget: { repeats: 3 },
    });
    const view = await waitFor(tasks, blocked.taskId, (item) => item.status !== "running");
    expect(view.status).toBe("failed");
    expect(view.settleReason).toBe("provider-blocked");
    expect(view.partial).toBe(false);
    expect(view.envelope).toBeUndefined();
    expect(view.warnings.join("\n")).toContain("not-in-scene");

    const halted = await ledger.listStudyRuns("project-1");
    expect(halted).toHaveLength(1);
    expect(halted[0]).toMatchObject({ status: "failed", settleReason: "provider-blocked" });
    const trace = await ledger.trace("project-1", { proposalFingerprint: blocked.proposalFingerprint });
    expect(trace.chains[0].runs).toHaveLength(0);
    expect(trace.chains[0].verdicts).toHaveLength(0);
  }, 20_000);

  it("账本写失败不推翻收口：settle 落账失败 → warning 上浮，任务仍如实 completed（不伪造失败）", async () => {
    const { ledger, tasks } = await buildEnv({ breakLedgerSettle: true });
    const launched = await tasks.launch("project-1", "tester:1", { hypothesis: POSITIVE_HYPOTHESIS, budget: { repeats: 1 } });
    const view = await waitFor(tasks, launched.taskId, (item) => item.status !== "running");
    expect(view.status).toBe("completed");
    expect(view.envelope?.verdict).toBe("confirmed");
    expect(view.resultFingerprint).toBe(view.envelope?.resultFingerprint);
    expect(view.warnings.join("\n")).toContain("provenance-ledger-write-failed(study-settle)");
    expect(ledger.listStudyRuns).toBeDefined();
  }, 20_000);

  it("断线恢复后取消：resumed-after-restart 与 cancelled 如实并存，partial 保留，账本保留取消态", async () => {
    const first = await buildEnv({ stepDelayMs: 8 });
    const launched = await first.tasks.launch("project-1", "tester:1", { hypothesis: POSITIVE_HYPOTHESIS, budget: { repeats: 400 } });
    first.tasks.dispose();

    const resumedLedger = new ProvenanceLedgerStore(first.directory);
    await resumedLedger.init();
    const resumedTasks = new SimulationStudyTaskStore(first.directory, {
      ledger: resumedLedger,
      goldenProvider: createGoldenVerifyProvider(),
      stepDelayMs: 8,
    });
    await resumedTasks.init();
    const resumed = await waitFor(
      resumedTasks,
      launched.taskId,
      (item) => item.warnings.includes("resumed-after-restart") && item.progress.completedRepeats >= 1,
    );
    expect(resumed.status).toBe("running");

    const cancelled = await resumedTasks.cancel("project-1", launched.taskId, { principal: "tester:1" });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.settleReason).toBe("user");
    expect(cancelled.partial).toBe(true);
    expect(cancelled.warnings).toContain("resumed-after-restart");
    expect(cancelled.envelope).toBeUndefined();

    const halted = await resumedLedger.listStudyRuns("project-1");
    expect(halted).toHaveLength(1);
    expect(halted[0]).toMatchObject({ status: "cancelled", settleReason: "user" });
    resumedTasks.dispose();
  }, 20_000);

  it("已收口任务重启幂等：completed 不重调度、信封保留、账本无新运行段、链恰一条", async () => {
    const first = await buildEnv();
    const launched = await first.tasks.launch("project-1", "tester:1", { hypothesis: POSITIVE_HYPOTHESIS, budget: { repeats: 1 } });
    const done = await waitFor(first.tasks, launched.taskId, (item) => item.status === "completed");
    expect(first.tasks.dispose()).toBe(0);

    const resumedTasks = new SimulationStudyTaskStore(first.directory, {
      ledger: first.ledger,
      goldenProvider: createGoldenVerifyProvider(),
    });
    await resumedTasks.init();
    const after = await resumedTasks.status("project-1", launched.taskId);
    expect(after?.status).toBe("completed");
    expect(after?.resultFingerprint).toBe(done.resultFingerprint);
    expect(after?.envelope?.verdict).toBe("confirmed");
    expect(after?.warnings).not.toContain("resumed-after-restart");

    const trace = await first.ledger.trace("project-1", { resultFingerprint: done.resultFingerprint! });
    expect(trace.chains).toHaveLength(1);
    expect(trace.chains[0].verdicts).toHaveLength(1);
    expect(await first.ledger.listStudyRuns("project-1")).toEqual([]);
  }, 20_000);

  it("失败任务重启不重调度：provider-blocked 保持收口态，恢复标记不出现，账本失败记录不翻新", async () => {
    const first = await buildEnv();
    const bad = await first.tasks.launch("project-1", "tester:1", {
      hypothesis: {
        ...POSITIVE_HYPOTHESIS,
        id: "hyp-study-admission-2",
        prediction: { ...POSITIVE_HYPOTHESIS.prediction, resourceId: "not-in-scene" },
      },
    });
    const failed = await waitFor(first.tasks, bad.taskId, (item) => item.status !== "running");
    expect(failed.status).toBe("failed");

    const resumedTasks = new SimulationStudyTaskStore(first.directory, {
      ledger: first.ledger,
      goldenProvider: createGoldenVerifyProvider(),
    });
    await resumedTasks.init();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const after = await resumedTasks.status("project-1", bad.taskId);
    expect(after?.status).toBe("failed");
    expect(after?.settleReason).toBe("provider-blocked");
    expect(after?.warnings).not.toContain("resumed-after-restart");
    const halted = await first.ledger.listStudyRuns("project-1");
    expect(halted).toHaveLength(1);
    expect(halted[0].status).toBe("failed");
  }, 20_000);

  it("运行中轮询可见：completedRepeats 单调不减、totalRepeats 保持、收口归位为 completed", async () => {
    const { tasks } = await buildEnv({ stepDelayMs: 10 });
    const launched = await tasks.launch("project-1", "tester:1", { hypothesis: POSITIVE_HYPOTHESIS, budget: { repeats: 3 } });
    const samples: number[] = [];
    let finalStatus = "";
    for (;;) {
      const view = await tasks.status("project-1", launched.taskId);
      if (!view) throw new Error("运行中任务句柄应可轮询");
      expect(view.progress.totalRepeats).toBe(3);
      samples.push(view.progress.completedRepeats);
      finalStatus = view.status;
      if (view.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    for (let index = 1; index < samples.length; index++) {
      expect(samples[index]).toBeGreaterThanOrEqual(samples[index - 1]);
    }
    expect(samples.at(-1)).toBe(3);
    expect(finalStatus).toBe("completed");
  }, 20_000);
});
