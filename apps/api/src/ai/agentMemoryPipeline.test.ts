import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DataQuerySource } from "@bim-studio/data-query-plugin";
import { PluginRegistry } from "@bim-studio/plugin-runtime";
import {
  IndustrialAgentOrchestrator,
  MemoryAgentCheckpointStore,
  type AgentCheckpoint,
  type AgentToolGateway,
} from "@bim-studio/industrial-agent-orchestrator";
import {
  agentMemoryContextDelivery,
  createIndustrialAgentDecisionProvider,
} from "./industrialAgentDecisionProvider.js";
import { createAgentHarnessGuards } from "./agentHarnessGuards.js";
import { AgentMemoryStore, AGENT_LESSON_INJECTION_MAX_COUNT, AGENT_RUN_ARCHIVE_MAX_RECORDS } from "./agentMemory.js";
import {
  AGENT_DISTILL_INPUT_MAX_CHARS,
  createAgentMemoryPipeline,
  distillLessonsFromCheckpoint,
} from "./agentMemoryPipeline.js";
import { AiReliabilityAuditBuffer } from "./aiReliabilityAudit.js";

/**
 * H-C6-S2 专家日志三段流水线：归档（run 终态自动落档）→ 提炼（预算内结构化 lesson，
 * 可截断/取消）→ 回灌（下轮 decide 注入，域匹配 + 条数预算，失败落审计 finding）。
 * 失败路径按 K8 口径逐段验证；端到端以真实 decisionProvider 走两轮 agent 场景。
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function createStore(): Promise<AgentMemoryStore> {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-memory-pipeline-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = new AgentMemoryStore(directory);
  await store.init();
  return store;
}

function checkpointFixture(patch: Partial<AgentCheckpoint> = {}): AgentCheckpoint {
  return {
    schemaVersion: 1,
    id: "run-1",
    projectId: "project-1",
    principal: "operator",
    objective: "排查产线节拍",
    context: {},
    status: "failed",
    budget: { maxSteps: 8, maxToolCalls: 5, maxDurationMs: 60_000 },
    usage: { steps: 3, toolCalls: 2, activeDurationMs: 1_000 },
    allowedToolIds: ["data.read", "data.query.plan"],
    decisions: [],
    toolRecords: [],
    seenToolFingerprints: [],
    failure: { code: "tool-failed", message: "数据源连接超时", retryable: true },
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:01:00.000Z",
    revision: 4,
    ...patch,
  };
}

describe("H-C6-S2 归档：run 终态自动落档", () => {
  it("终态 checkpoint 归档：runId/状态/摘要/用量/工具域齐备；同 runId 重收口覆盖（幂等）", async () => {
    const store = await createStore();
    const pipeline = createAgentMemoryPipeline({ memory: store });
    await pipeline.onRunSettled(checkpointFixture());
    const archives = await store.listRunArchives("project-1");
    expect(archives).toHaveLength(1);
    expect(archives[0]).toMatchObject({
      runId: "run-1",
      status: "failed",
      failureCode: "tool-failed",
      steps: 3,
      toolCalls: 2,
      toolIds: ["data.read", "data.query.plan"],
    });
    expect(archives[0]?.objective).toContain("产线节拍");
    expect(archives[0]?.outcomeSummary).toContain("tool-failed");

    // 重收口（重试/恢复后再收口）：覆盖而非重复，滚动置顶。
    await pipeline.onRunSettled(checkpointFixture({ usage: { steps: 5, toolCalls: 3, activeDurationMs: 2_000 } }));
    const after = await store.listRunArchives("project-1");
    expect(after).toHaveLength(1);
    expect(after[0]?.steps).toBe(5);
  });

  it("归档滚动窗口：超出上限逐出最旧", async () => {
    const store = await createStore();
    const pipeline = createAgentMemoryPipeline({ memory: store });
    for (let index = 0; index <= AGENT_RUN_ARCHIVE_MAX_RECORDS + 1; index += 1) {
      await pipeline.onRunSettled(checkpointFixture({ id: `run-${index}` }));
    }
    const archives = await store.listRunArchives("project-1");
    expect(archives).toHaveLength(AGENT_RUN_ARCHIVE_MAX_RECORDS);
    expect(archives[0]?.runId).toBe(`run-${AGENT_RUN_ARCHIVE_MAX_RECORDS + 1}`);
  });

  it("完成且无异常的 run 归档但不产 lesson（零噪纪律；取消的 run 不产教训）", async () => {
    const store = await createStore();
    const pipeline = createAgentMemoryPipeline({ memory: store });
    await pipeline.onRunSettled(checkpointFixture({
      id: "run-done",
      status: "completed",
      failure: undefined,
      completion: { kind: "finish", rationale: "完成", summary: "节拍达标", decisionStatus: "shadow", evidenceIds: [] },
    }));
    await pipeline.onRunSettled(checkpointFixture({ id: "run-cancel", status: "cancelled", failure: { code: "cancelled", message: "用户取消", retryable: false } }));
    expect(await store.listRunArchives("project-1")).toHaveLength(2);
    expect(await store.listLessons("project-1")).toHaveLength(0);
  });
});

describe("H-C6-S2 提炼：预算内结构化 lesson", () => {
  it("失败提炼：规则码 + 教训内容 + 工具域；预算耗尽给拆分建议", () => {
    const lessons = distillLessonsFromCheckpoint(checkpointFixture());
    expect(lessons).toHaveLength(1);
    expect(lessons[0]?.code).toBe("failure:tool-failed");
    expect(lessons[0]?.toolIds).toEqual(["data.read", "data.query.plan"]);
    expect(lessons[0]?.content).toContain("数据源连接超时");

    const budget = distillLessonsFromCheckpoint(checkpointFixture({
      status: "budget-exhausted",
      failure: { code: "step-budget", message: "Agent 已达到最大步骤数", retryable: false },
    }));
    expect(budget[0]?.code).toBe("failure:step-budget");
    expect(budget[0]?.content).toContain("3 步");
    expect(budget[0]?.content).toContain("拆分");
  });

  it("回灌缺口提炼：postExecuteFindings 存在时产出 feedback lesson", () => {
    const lessons = distillLessonsFromCheckpoint(checkpointFixture({
      status: "completed",
      failure: undefined,
      guards: { postExecuteFindings: [{ step: 2, toolId: "simulation.golden.verify", code: "post-execute-failed", message: "verdict 回灌存储不可用", occurredAt: "2026-10-02T00:00:30.000Z", retryable: true }] },
    }));
    expect(lessons).toHaveLength(1);
    expect(lessons[0]?.code).toBe("feedback:post-execute-failed");
    expect(lessons[0]?.content).toContain("回灌失败");
  });

  it("提炼预算：条数上限截断；输入摘要超限被截断；取消信号下零产出", () => {
    const longFailure = checkpointFixture({
      failure: { code: "tool-failed", message: "超时".repeat(600), retryable: true },
    });
    const lessons = distillLessonsFromCheckpoint(longFailure, { maxLessons: 1 });
    expect(lessons[0]?.content.length).toBeLessThan(AGENT_DISTILL_INPUT_MAX_CHARS + 100);

    const controller = new AbortController();
    controller.abort();
    expect(distillLessonsFromCheckpoint(checkpointFixture(), { signal: controller.signal })).toEqual([]);
  });
});

describe("H-C6-S2 回灌：域匹配 + 条数预算", () => {
  it("loadDelivery 注入 lessons（run-lessons 源 + 上下文形态）；域无交集不注入；全域经验始终注入", async () => {
    const store = await createStore();
    await store.replaceLessons("project-1", "run-a", [
      { code: "failure:tool-failed", content: "data.read 失败先查连接", toolIds: ["data.read"] },
      { code: "guard:variant-circuit", content: "全域教训：同参调用不得重发", toolIds: [] },
    ]);
    const agentDelivery = await store.loadDelivery("project-1", 6_000, { toolIds: ["simulation.golden.verify"] });
    // 域匹配：data.read 教训对 golden.verify run 不相关，只有全域经验注入。
    expect(agentDelivery.lessons.map((item) => item.code)).toEqual(["guard:variant-circuit"]);
    expect(agentDelivery.sources.map((item) => item.id)).toContain("run-lessons");

    const matched = await store.loadDelivery("project-1", 6_000, { toolIds: ["data.read"] });
    expect(matched.lessons).toHaveLength(2);

    // chat 侧（无 match）：全部经验可注入。
    const chat = await store.loadDelivery("project-1");
    expect(chat.lessons).toHaveLength(2);

    const context = agentMemoryContextDelivery(matched);
    expect(context.lessons?.map((item) => item.code)).toEqual(["failure:tool-failed", "guard:variant-circuit"]);
    // 注入形态精简：不带 id/runId/createdAt（提示词最小化）。
    expect(Object.keys(context.lessons?.[0] ?? {}).sort()).toEqual(["code", "content", "toolIds"]);
  });

  it("条数预算：域匹配后仍受 AGENT_LESSON_INJECTION_MAX_COUNT 约束", async () => {
    const store = await createStore();
    await store.replaceLessons("project-1", "run-a", Array.from({ length: 7 }, (_, index) => ({
      code: `failure:rule-${index}`,
      content: `教训 ${index}`,
      toolIds: ["data.read"],
    })));
    const delivery = await store.loadDelivery("project-1", 60_000, { toolIds: ["data.read"] });
    expect(delivery.lessons).toHaveLength(AGENT_LESSON_INJECTION_MAX_COUNT);
  });

  it("旧档/坏行 fail-closed：无 runs/lessons 段按空读入，坏行丢弃不回退", async () => {
    const store = await createStore();
    // 同一文档写记忆与 verdict（旧 schema 形态），新段缺省读空。
    await store.addMemoryCandidate("project-1", { content: "历史候选" });
    const archives = await store.listRunArchives("project-1");
    const lessons = await store.listLessons("project-1");
    expect(archives).toEqual([]);
    expect(lessons).toEqual([]);
    const delivery = await store.loadDelivery("project-1");
    expect(delivery.configured).toBe(false);
    expect(delivery.lessons).toEqual([]);
  });
});

describe("H-C6-S2 失败路径：落审计 finding（K8 口径），run 终态不受影响", () => {
  it("归档失败：audit finding run-archive-failed，不向上抛", async () => {
    const audit = new AiReliabilityAuditBuffer();
    const broken = { archiveRun: async () => { throw new Error("磁盘只读"); } } as unknown as AgentMemoryStore;
    const pipeline = createAgentMemoryPipeline({ memory: broken, audit: audit.sink });
    await expect(pipeline.onRunSettled(checkpointFixture())).resolves.toBeUndefined();
    const event = audit.list().at(-1)!;
    expect(event.findings.map((item) => item.code)).toContain("run-archive-failed");
    expect(event.failure).toMatchObject({ code: "run-archive-failed", retryable: true });
  });

  it("提炼落档失败：audit finding lesson-store-failed，已完成的归档保留", async () => {
    const audit = new AiReliabilityAuditBuffer();
    const archived: string[] = [];
    const broken = {
      archiveRun: async (projectId: string, input: { runId: string }) => { archived.push(input.runId); return { archive: input as never, duplicate: false }; },
      replaceLessons: async () => { throw new Error("lesson 段损坏"); },
    } as unknown as AgentMemoryStore;
    const pipeline = createAgentMemoryPipeline({ memory: broken, audit: audit.sink });
    await pipeline.onRunSettled(checkpointFixture());
    expect(archived).toEqual(["run-1"]);
    const event = audit.list().at(-1)!;
    expect(event.findings.map((item) => item.code)).toContain("lesson-store-failed");
  });
});

// ---------------------------------------------------------------------------
// 端到端两跑（CPU 场景 ×2）：运行 → 归档 → 提炼 → 新会话回灌断言
// 真实 decisionProvider + 真实记忆投递 + 真实审计路径，零外部依赖。
// ---------------------------------------------------------------------------

const dataQuerySource: DataQuerySource = {
  listDatasets: () => [],
  getDataset: () => undefined,
  readDataset: async () => ({ dataset: undefined as never, fields: [], rows: [] }),
};

async function e2eScenario(options: { memoryReadFailure?: boolean } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-memory-e2e-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const memory = new AgentMemoryStore(directory);
  await memory.init();
  const audit = new AiReliabilityAuditBuffer();
  const pipeline = createAgentMemoryPipeline({ memory, audit: audit.sink });
  const capturedContexts: Array<Record<string, unknown>> = [];

  const registry = new PluginRegistry({
    apiVersion: "1.0", sceneApiVersion: "1.0", host: "cloud", renderer: "webgl2",
    capabilities: ["ai.provider", "data.query"], permissions: ["ai.invoke", "data.read"],
    extensionPoints: ["ai.provider", "capability.provider"], allowTrustedSceneExtensions: false,
  });
  let round = 0;
  const registered = registry.register({
    schemaVersion: 1, id: "test.ai", name: "Pipeline QA planner", version: "1.0.0", apiVersion: "1.0", hosts: ["cloud"],
    capabilities: ["ai.provider"], permissions: ["ai.invoke"],
    extensionPoints: [{ kind: "ai.provider", id: "test.runtime", providerIds: ["ai.test"], execution: "in-process", limits: { timeoutMs: 1_000, maxInputBytes: 1_000_000, memoryMb: 32 } }],
  }, ({ registerAiProvider }) => registerAiProvider({
    descriptor: { id: "ai.test", version: "1.0.0", label: "Pipeline planner", execution: "in-process", permissions: ["ai.invoke"], streaming: false, timeoutMs: 1_000 },
    async complete(request) {
      capturedContexts.push((JSON.parse(request.input) as { context: Record<string, unknown> }).context);
      if (round === 0) {
        round += 1;
        return { text: JSON.stringify({
          kind: "call-tool", rationale: "读取数据",
          call: { toolId: "data.read", arguments: {}, resources: [{ kind: "project", id: "project-1" }] },
        }), model: "qa" };
      }
      return { text: JSON.stringify({ kind: "finish", rationale: "参考上轮教训", summary: "已完成", decisionStatus: "shadow", evidenceIds: [] }), model: "qa" };
    },
  }));
  expect(registered.ok).toBe(true);
  expect((await registry.enable("test.ai")).ok).toBe(true);

  const decisions = createIndustrialAgentDecisionProvider({
    registry,
    dataSource: dataQuerySource,
    settings: () => ({ providerId: "ai.test", model: "qa", protocol: "responses", baseUrl: "https://example.test", apiKey: "qa", temperature: 0 }),
    audit: audit.sink,
    memory: options.memoryReadFailure
      ? async () => { throw new Error("memories.json 读取失败"); }
      : (projectId, toolIds) => memory.loadDelivery(projectId, undefined, toolIds ? { toolIds } : undefined),
  });
  const READ_TOOL = { id: "data.read", label: "读取", description: "read", effect: "read" as const, risk: "low" as const, requiresApproval: false };
  let toolCalls = 0;
  const tools: AgentToolGateway = {
    list: () => [{ ...READ_TOOL }],
    fingerprint: (call) => `fp:${call.toolId}:${JSON.stringify(call.arguments)}`,
    execute: async () => {
      toolCalls += 1;
      // 第一轮工具真实抛错（读工具执行失败 → run failed）；第二轮成功。
      if (toolCalls === 1) throw new Error("数据源连接超时");
      return { status: "completed" as const, output: { rows: 1 }, evidence: [], verificationEvidence: [] };
    },
  };
  const orchestrator = new IndustrialAgentOrchestrator({
    decisions,
    tools,
    checkpoints: new MemoryAgentCheckpointStore(),
    guards: createAgentHarnessGuards({ audit: audit.sink, memory, calibrationResourceIds: ["sensor-station"] }),
    onRunSettled: pipeline.onRunSettled,
  });

  // 第一轮：运行 → 工具失败 → 终态自动归档+提炼（onRunSettled 在 start 返回前完成）。
  const first = await orchestrator.start({
    projectId: "project-1",
    principal: "operator",
    objective: "排查产线节拍",
    allowedToolIds: ["data.read"],
  });
  expect(first.status).toBe("failed");
  const archives = await memory.listRunArchives("project-1");
  expect(archives.map((item) => item.runId)).toContain(first.id);
  const lessons = await memory.listLessons("project-1");
  expect(lessons.some((item) => item.code === "failure:tool-failed" && item.runId === first.id)).toBe(true);

  // 第二轮（新会话）：提炼经验自动进入 decide 上下文与逐源审计。
  capturedContexts.length = 0;
  const second = await orchestrator.start({
    projectId: "project-1",
    principal: "operator",
    objective: "再查节拍",
    allowedToolIds: ["data.read"],
  });
  expect(second.status).toBe("completed");
  const assessments = audit.list().filter((event) => event.stage === "input-assessment");
  const lastAssessment = assessments.at(-1)!;
  if (options.memoryReadFailure) {
    // H-C5-K8：回灌读取失败——落专项 finding、零注入继续，不烧整轮。
    expect(capturedContexts[0]?.agentMemoryContext).toBeUndefined();
    expect(lastAssessment.findings.map((item) => item.code)).toContain("memory-delivery-failed");
    return { firstRunId: first.id, lessonCount: lessons.length };
  }
  const memoryContext = capturedContexts[0]?.agentMemoryContext as ReturnType<typeof agentMemoryContextDelivery> | undefined;
  expect(memoryContext?.lessons?.[0]).toMatchObject({ code: "failure:tool-failed" });
  expect(memoryContext?.lessons?.[0]?.content).toContain("数据源连接超时");
  expect(lastAssessment.findings.map((item) => item.code)).toContain("context-source:run-lessons");
  return { firstRunId: first.id, lessonCount: lessons.length };
}

describe("H-C6-S2 端到端两跑（运行→归档→提炼→回灌）", () => {
  it("第 1 跑：失败教训跨会话回灌", async () => {
    const result = await e2eScenario();
    expect(result.firstRunId).toBeTruthy();
    expect(result.lessonCount).toBeGreaterThan(0);
  });

  it("第 2 跑：同场景复跑结论稳定（幂等归档、稳定注入）", async () => {
    const result = await e2eScenario();
    expect(result.firstRunId).toBeTruthy();
    expect(result.lessonCount).toBeGreaterThan(0);
  });

  it("回灌读取失败路径：落 memory-delivery-failed finding，零注入继续不烧轮（K8）", async () => {
    const result = await e2eScenario({ memoryReadFailure: true });
    expect(result.firstRunId).toBeTruthy();
    // 归档与提炼照常落档（失败只在 decide 读取侧）。
    expect(result.lessonCount).toBeGreaterThan(0);
  });
});
