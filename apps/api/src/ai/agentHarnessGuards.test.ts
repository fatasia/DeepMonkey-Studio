import { tmpdir } from "node:os";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCheckpoint, AgentToolCall } from "@bim-studio/industrial-agent-orchestrator";
import type { AiReliabilityAuditEvent } from "./aiReliabilityAudit.js";
import { createAgentHarnessGuards } from "./agentHarnessGuards.js";
import { AgentMemoryStore, AgentMemoryLimitError } from "./agentMemory.js";

const dataDirs: string[] = [];
afterEach(async () => {
  await Promise.all(dataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeStore(): Promise<AgentMemoryStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-guards-"));
  dataDirs.push(dir);
  const store = new AgentMemoryStore(dir);
  await store.init();
  return store;
}

/** RULES.md 是人写文件：测试模拟用户在目录已存在时直接落盘。 */
async function writeRules(memory: AgentMemoryStore, projectId: string, content: string): Promise<void> {
  const rulesPath = memory.rulesPath(projectId);
  await mkdir(path.dirname(rulesPath), { recursive: true });
  await writeFile(rulesPath, content, "utf8");
}

const BASE_HYPOTHESIS = {
  hypothesisVersion: "1",
  id: "h-1",
  statement: "传感器工位利用率低于 0.2",
  targetModel: "t23-conveyor-sensor-agv",
  prediction: { metric: "resource-utilization", resourceId: "sensor-station", comparator: "less-than", expected: 0.2 },
  tolerance: { absolute: 0.05 },
};

function hypothesisCall(toolId: string, hypothesis: unknown, extraArguments: Record<string, unknown> = {}): AgentToolCall {
  return {
    toolId,
    arguments: { hypothesis, ...extraArguments },
    resources: [{ kind: "project", id: "project-1" }],
  };
}

function context(overrides: { checkpoint?: Partial<AgentCheckpoint>; call?: AgentToolCall } = {}) {
  const signal = new AbortController().signal;
  return {
    checkpoint: {
      schemaVersion: 1 as const,
      id: "run-1",
      projectId: "project-1",
      principal: "operator",
      objective: "验证假设",
      context: {},
      status: "running" as const,
      budget: { maxSteps: 8, maxToolCalls: 6, maxDurationMs: 60_000 },
      usage: { steps: 1, toolCalls: 0, activeDurationMs: 0 },
      allowedToolIds: ["simulation.hypothesis.register", "simulation.golden.verify"],
      decisions: [],
      toolRecords: [],
      seenToolFingerprints: [],
      createdAt: "2026-09-28T10:00:00.000Z",
      updatedAt: "2026-09-28T10:00:00.000Z",
      revision: 1,
      ...overrides.checkpoint,
    },
    call: overrides.call ?? hypothesisCall("simulation.golden.verify", BASE_HYPOTHESIS),
    effect: "analyze" as const,
    signal,
  };
}

function auditBuffer() {
  const events: AiReliabilityAuditEvent[] = [];
  return { events, sink: (event: AiReliabilityAuditEvent) => { events.push(structuredClone(event)); } };
}

const VALID_RESOURCE_IDS = ["sensor-station", "agv-unit"];

describe("H-C2 语义预检（pre-execute，理由码 semantic-admission）", () => {
  it("合法假设放行：不拒绝、不产生审计事件", async () => {
    const audit = auditBuffer();
    const guards = createAgentHarnessGuards({ audit: audit.sink, calibrationResourceIds: VALID_RESOURCE_IDS });
    const admission = await guards.preExecute?.(context());
    expect(admission).toBeUndefined();
    expect(audit.events).toHaveLength(0);
  });

  it("负预热等合同外字段被拒：未知字段 fail-closed，理由码 semantic-admission 且落 denied 审计", async () => {
    const audit = auditBuffer();
    const guards = createAgentHarnessGuards({ audit: audit.sink, calibrationResourceIds: VALID_RESOURCE_IDS });
    const rejection = await guards.preExecute?.(context({ call: hypothesisCall("simulation.hypothesis.register", { ...BASE_HYPOTHESIS, warmupMinutes: -100 }),
    }));
    expect(rejection?.code).toBe("semantic-admission");
    expect(rejection?.message).toContain("hypothesis.warmupMinutes");
    expect(rejection?.variantKey).toMatch(/^[0-9a-f]{16}$/);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({ stage: "tool-decision", outcome: "denied" });
    expect(audit.events[0]?.findings[0]).toMatchObject({ code: "reason:semantic-admission", sourceId: "simulation.hypothesis.register" });
    expect(audit.events[0]?.failure?.code).toBe("semantic-admission");
  });

  it("超窗字段同理被拒：windowMinutes 不在合同白名单", async () => {
    const guards = createAgentHarnessGuards({ calibrationResourceIds: VALID_RESOURCE_IDS });
    const rejection = await guards.preExecute?.(context({ call: hypothesisCall("simulation.golden.verify", { ...BASE_HYPOTHESIS, windowMinutes: 1_000_000_000 }),
    }));
    expect(rejection?.code).toBe("semantic-admission");
    expect(rejection?.message).toContain("windowMinutes");
  });

  it("容差覆盖比例指标整个值域（恒 inconclusive）按超窗拒绝", async () => {
    const guards = createAgentHarnessGuards({ calibrationResourceIds: VALID_RESOURCE_IDS });
    const rejection = await guards.preExecute?.(context({ call: hypothesisCall("simulation.golden.verify", {
        ...BASE_HYPOTHESIS,
        prediction: { ...BASE_HYPOTHESIS.prediction, expected: 1 },
        tolerance: { absolute: 1 },
      }),
    }));
    expect(rejection?.code).toBe("semantic-admission");
    expect(rejection?.message).toContain("超窗");
  });

  it("资源引用不在目标场景：pre-execute 即拒（内核执行前给修正理由）", async () => {
    const guards = createAgentHarnessGuards({ calibrationResourceIds: VALID_RESOURCE_IDS });
    const rejection = await guards.preExecute?.(context({ call: hypothesisCall("simulation.golden.verify", {
        ...BASE_HYPOTHESIS,
        prediction: { ...BASE_HYPOTHESIS.prediction, resourceId: "ghost-resource" },
      }),
    }));
    expect(rejection?.code).toBe("semantic-admission");
    expect(rejection?.message).toContain("ghost-resource");
  });

  it("合同形状错误（比例阈值越界/负预期）拒绝并给出字段定位", async () => {
    const guards = createAgentHarnessGuards({ calibrationResourceIds: VALID_RESOURCE_IDS });
    const ratio = await guards.preExecute?.(context({ call: hypothesisCall("simulation.golden.verify", {
        ...BASE_HYPOTHESIS,
        prediction: { ...BASE_HYPOTHESIS.prediction, expected: 1.5 },
      }),
    }));
    expect(ratio?.code).toBe("semantic-admission");
    expect(ratio?.message).toContain("prediction.expected");
    const missing = await guards.preExecute?.(context({ call: hypothesisCall("simulation.golden.verify", { ...BASE_HYPOTHESIS, id: "" }),
    }));
    expect(missing?.code).toBe("semantic-admission");
    expect(missing?.message).toContain("id");
  });

  it("非假设工具一律放行（挂载点只作用于语义预检作用面）", async () => {
    const audit = auditBuffer();
    const guards = createAgentHarnessGuards({ audit: audit.sink, calibrationResourceIds: VALID_RESOURCE_IDS });
    const admission = await guards.preExecute?.(context({
      call: { toolId: "data.query.read", arguments: { datasetId: "x" }, resources: [{ kind: "project", id: "project-1" }] },
    }));
    expect(admission).toBeUndefined();
    expect(audit.events).toHaveLength(0);
  });

  it("变体键稳定：参数微扰（expected/tolerance/statement）不换键；换假设标识换键", async () => {
    const guards = createAgentHarnessGuards({ calibrationResourceIds: VALID_RESOURCE_IDS });
    const first = await guards.preExecute?.(context({ call: hypothesisCall("simulation.golden.verify", { ...BASE_HYPOTHESIS, warmupMinutes: -1 }),
    }));
    const perturbed = await guards.preExecute?.(context({ call: hypothesisCall("simulation.golden.verify", {
        ...BASE_HYPOTHESIS,
        warmupMinutes: -1,
        statement: "改了陈述",
        prediction: { ...BASE_HYPOTHESIS.prediction, expected: 0.3 },
        tolerance: { absolute: 0.02 },
      }),
    }));
    const renamed = await guards.preExecute?.(context({ call: hypothesisCall("simulation.golden.verify", { ...BASE_HYPOTHESIS, id: "h-2", warmupMinutes: -1 }),
    }));
    expect(first?.variantKey).toBe(perturbed?.variantKey);
    expect(first?.variantKey).not.toBe(renamed?.variantKey);
  });
});

describe("H-C2 verdict 回灌（post-execute）", () => {
  const ENVELOPE = {
    proposalFingerprint: "0123456789abcdef",
    inputFingerprint: "123456789abcdef0",
    resultFingerprint: "23456789abcdef01",
    verdict: "refuted",
    tolerance: { absolute: 0.05 },
    reasonCode: "prediction-outside-tolerance",
    rationale: "实测 0.42 高于阈值 0.2，方向相反且越过容差带。",
    generatedAt: "2026-09-28T10:00:00.000Z",
    evidence: [],
  };

  it("refuted 信封写入 verdict 摘要，并生成待确认候选记忆（用户确认制）", async () => {
    const memory = await makeStore();
    const guards = createAgentHarnessGuards({ memory, calibrationResourceIds: VALID_RESOURCE_IDS });
    await guards.postExecute?.({
      checkpoint: context().checkpoint,
      call: context().call,
      effect: "analyze",
      outcome: { status: "completed", output: ENVELOPE, evidence: [], verificationEvidence: [] },
    });
    const verdicts = await memory.listVerdicts("project-1");
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      proposalFingerprint: "0123456789abcdef",
      verdict: "refuted",
      reasonCode: "prediction-outside-tolerance",
      runId: "run-1",
      step: 1,
    });
    const memories = await memory.listMemories("project-1");
    expect(memories).toHaveLength(1);
    expect(memories[0]?.status).toBe("pending");
    expect(memories[0]?.content).toContain("被内核反驳");
    expect(memories[0]?.origin.proposalFingerprint).toBe("0123456789abcdef");
  });

  it("confirmed 信封只进 verdict 摘要，不生成候选记忆", async () => {
    const memory = await makeStore();
    const guards = createAgentHarnessGuards({ memory, calibrationResourceIds: VALID_RESOURCE_IDS });
    await guards.postExecute?.({
      checkpoint: context().checkpoint,
      call: context().call,
      effect: "analyze",
      outcome: { status: "completed", output: { ...ENVELOPE, verdict: "confirmed", reasonCode: "prediction-within-tolerance" }, evidence: [], verificationEvidence: [] },
    });
    expect(await memory.listVerdicts("project-1")).toHaveLength(1);
    expect(await memory.listMemories("project-1")).toHaveLength(0);
  });

  it("非 completed / 非信封输出 / 非 golden.verify 一律不写（诚实边界）", async () => {
    const memory = await makeStore();
    const guards = createAgentHarnessGuards({ memory, calibrationResourceIds: VALID_RESOURCE_IDS });
    const checkpoint = context().checkpoint;
    const call = context().call;
    await guards.postExecute?.({ checkpoint, call, effect: "analyze", outcome: { status: "failed", output: ENVELOPE, evidence: [], verificationEvidence: [], error: { code: "x", message: "x", retryable: true } } });
    await guards.postExecute?.({ checkpoint, call, effect: "analyze", outcome: { status: "completed", output: { broken: true }, evidence: [], verificationEvidence: [] } });
    await guards.postExecute?.({ checkpoint, call: { ...call, toolId: "data.query.read" }, effect: "read", outcome: { status: "completed", output: ENVELOPE, evidence: [], verificationEvidence: [] } });
    expect(await memory.listVerdicts("project-1")).toHaveLength(0);
    expect(await memory.listMemories("project-1")).toHaveLength(0);
  });

  it("记忆容量满时候选提炼静默降级，verdict 摘要不受影响", async () => {
    const memory = await makeStore();
    for (let index = 0; index < 100; index += 1) {
      await memory.addMemoryCandidate("project-1", { content: `既有候选 ${index}` });
    }
    const guards = createAgentHarnessGuards({ memory, calibrationResourceIds: VALID_RESOURCE_IDS });
    await guards.postExecute?.({
      checkpoint: context().checkpoint,
      call: context().call,
      effect: "analyze",
      outcome: { status: "completed", output: ENVELOPE, evidence: [], verificationEvidence: [] },
    });
    expect(await memory.listVerdicts("project-1")).toHaveLength(1);
    expect(await memory.listMemories("project-1")).toHaveLength(100);
  });

  it("容量上限对直接候选注入同样生效（AgentMemoryLimitError）", async () => {
    const memory = await makeStore();
    for (let index = 0; index < 100; index += 1) {
      await memory.addMemoryCandidate("project-1", { content: `候选 ${index}` });
    }
    await expect(memory.addMemoryCandidate("project-1", { content: "第 101 条" })).rejects.toThrowError(AgentMemoryLimitError);
  });
});

describe("H-C2 守则层（RULES.md，人写、只读）", () => {
  it("RULES.md 内容进注入投递，指纹随内容变化", async () => {
    const memory = await makeStore();
    await writeRules(memory, "project-1", "# 守则\n- 仿真只用于假设验证");
    const first = await memory.loadDelivery("project-1");
    expect(first.configured).toBe(true);
    expect(first.rules?.content).toContain("仿真只用于假设验证");
    const before = first.sources.find((source) => source.id === "rules-md");
    await writeRules(memory, "project-1", "# 守则\n- 仿真只用于假设验证\n- 不重复已反驳方案");
    const second = await memory.loadDelivery("project-1");
    const after = second.sources.find((source) => source.id === "rules-md");
    expect(after?.fingerprint).not.toBe(before?.fingerprint);
    expect(after?.chars).toBeGreaterThan(before?.chars ?? 0);
  });

  it("超过 200 行或 25KB 截断并标记 truncated", async () => {
    const memory = await makeStore();
    await writeRules(memory, "project-1", Array.from({ length: 260 }, (_, index) => `第 ${index} 行守则`).join("\n"));
    const byLines = await memory.loadDelivery("project-1");
    expect(byLines.rules?.truncated).toBe(true);
    expect(byLines.rules?.content.split("\n")).toHaveLength(200);
    await writeRules(memory, "project-1", "很长的守则".repeat(20_000));
    const byBytes = await memory.loadDelivery("project-1");
    expect(byBytes.rules?.truncated).toBe(true);
    expect(Buffer.byteLength(byBytes.rules?.content ?? "", "utf8")).toBeLessThanOrEqual(25 * 1024 + 64);
  });

  it("空文件视同未配置", async () => {
    const memory = await makeStore();
    await writeRules(memory, "project-1", "   \n  ");
    const delivery = await memory.loadDelivery("project-1");
    expect(delivery.configured).toBe(false);
    expect(delivery.sources).toHaveLength(0);
  });
});

describe("H-C2 偏好层（候选 → 确认 → 注入；启停/删除生效集变化）", () => {
  it("pending 不注入，confirm 后注入，disable 停止注入，delete 移除", async () => {
    const memory = await makeStore();
    const record = await memory.addMemoryCandidate("project-1", { content: "产线 A 的换型时间固定为 12 分钟", runId: "run-1", step: 3 });
    expect((await memory.loadDelivery("project-1")).memories).toHaveLength(0);
    await memory.confirmMemory("project-1", record.id, "chief-engineer");
    const active = await memory.loadDelivery("project-1");
    expect(active.memories).toHaveLength(1);
    expect(active.sources.find((source) => source.id === "agent-memories")).toBeDefined();
    await memory.updateMemory("project-1", record.id, { enabled: false });
    expect((await memory.loadDelivery("project-1")).memories).toHaveLength(0);
    await memory.updateMemory("project-1", record.id, { enabled: true });
    expect((await memory.loadDelivery("project-1")).memories).toHaveLength(1);
    await memory.deleteMemory("project-1", record.id);
    expect((await memory.loadDelivery("project-1")).memories).toHaveLength(0);
    expect((await memory.loadDelivery("project-1")).sources.find((source) => source.id === "agent-memories")).toBeUndefined();
  });

  it("pending 不允许直接启用（必须先确认）", async () => {
    const memory = await makeStore();
    const record = await memory.addMemoryCandidate("project-1", { content: "候选" });
    await expect(memory.updateMemory("project-1", record.id, { enabled: true })).rejects.toThrowError(AgentMemoryLimitError);
  });

  it("内容修改即时反映到注入", async () => {
    const memory = await makeStore();
    const record = await memory.addMemoryCandidate("project-1", { content: "旧内容" });
    await memory.confirmMemory("project-1", record.id, "chief-engineer");
    await memory.updateMemory("project-1", record.id, { content: "新内容：不要重复已反驳的方案" });
    const delivery = await memory.loadDelivery("project-1");
    expect(delivery.memories[0]?.content).toContain("新内容");
  });
});

describe("H-C2 结论层注入与预算", () => {
  const SUMMARY = {
    proposalFingerprint: "0123456789abcdef",
    resultFingerprint: "23456789abcdef01",
    verdict: "refuted" as const,
    reasonCode: "prediction-outside-tolerance",
    rationale: "实测高于阈值且越过容差带。",
  };

  it("verdict 摘要进 prior-verdicts 源；同 proposalFingerprint 覆盖不重复", async () => {
    const memory = await makeStore();
    await memory.recordVerdict("project-1", SUMMARY);
    await memory.recordVerdict("project-1", { ...SUMMARY, verdict: "confirmed", reasonCode: "prediction-within-tolerance" });
    const delivery = await memory.loadDelivery("project-1");
    expect(delivery.verdicts).toHaveLength(1);
    expect(delivery.verdicts[0]?.verdict).toBe("confirmed");
    const source = delivery.sources.find((item) => item.id === "prior-verdicts");
    expect(source).toBeDefined();
  });

  it("注入预算：预算不足以装下全部层时按优先级装入并在源上标记截断", async () => {
    const memory = await makeStore();
    await writeRules(memory, "project-1", "守则：" + "规则条目。".repeat(300));
    for (let index = 0; index < 12; index += 1) {
      const record = await memory.addMemoryCandidate("project-1", { content: `记忆条目 ${index}，` + "内容。".repeat(80) });
      await memory.confirmMemory("project-1", record.id, "chief-engineer");
    }
    await memory.recordVerdict("project-1", SUMMARY);
    const delivery = await memory.loadDelivery("project-1", 2_000);
    expect(delivery.configured).toBe(true);
    expect(delivery.rules).toBeDefined();
    const ids = delivery.sources.map((source) => source.id);
    expect(ids).toContain("rules-md");
    expect(ids).toContain("agent-memories");
    expect(ids).not.toContain("prior-verdicts");
    const totalChars = delivery.sources.reduce((total, source) => total + source.chars, 0);
    expect(totalChars).toBeLessThanOrEqual(2_000);
    expect(delivery.sources.some((source) => source.truncated)).toBe(true);
  });

  it("未配置任何源时零注入零源（零开销可证伪点）", async () => {
    const memory = await makeStore();
    const delivery = await memory.loadDelivery("project-1");
    expect(delivery.configured).toBe(false);
    expect(delivery.rules).toBeUndefined();
    expect(delivery.memories).toHaveLength(0);
    expect(delivery.verdicts).toHaveLength(0);
    expect(delivery.sources).toHaveLength(0);
    expect(delivery.injectionChars).toBe(0);
  });

  it("注入内容不含用户数据原文以外的副作用：memories.json 落盘结构可查", async () => {
    const memory = await makeStore();
    const record = await memory.addMemoryCandidate("project-1", { content: "候选", runId: "run-9" });
    await memory.confirmMemory("project-1", record.id, "chief-engineer");
    const raw = JSON.parse(await readFile(path.join(memory.rulesPath("project-1"), "..", "memories.json"), "utf8"));
    expect(raw.schemaVersion).toBe(1);
    expect(raw.memories[0]).toMatchObject({ id: record.id, status: "active", confirmedBy: "chief-engineer" });
  });
});
