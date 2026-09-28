import { tmpdir } from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DataQuerySource } from "@bim-studio/data-query-plugin";
import { PluginRegistry } from "@bim-studio/plugin-runtime";
import { IndustrialAgentOrchestrator, MemoryAgentCheckpointStore } from "@bim-studio/industrial-agent-orchestrator";
import { fingerprint64Labeled } from "@bim-studio/contracts";
import { createIndustrialAgentDecisionProvider } from "./industrialAgentDecisionProvider.js";
import { createAgentHarnessGuards } from "./agentHarnessGuards.js";
import { AgentMemoryStore } from "./agentMemory.js";
import { AiReliabilityAuditBuffer } from "./aiReliabilityAudit.js";

/**
 * H-C2 回灌闭环集成：第一轮 run 完成 golden.verify（内核直调 capability 不需要，
 * 直接以 provider 决策返回 envelope 等价物）→ post-execute 记 verdict 摘要 →
 * 第二轮 run 的提示词上下文含上轮结论，且投递审计出现逐源 finding。
 * 全链零外部依赖：decision provider 走真实 prepareAiInput/预算/审计路径。
 */

const dataDirs: string[] = [];
afterEach(async () => {
  await Promise.all(dataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const VERIFIED_ENVELOPE = {
  proposalFingerprint: "0123456789abcdef",
  inputFingerprint: "123456789abcdef0",
  resultFingerprint: "23456789abcdef01",
  verdict: "refuted",
  tolerance: { absolute: 0.05 },
  reasonCode: "prediction-outside-tolerance",
  rationale: "实测资源利用率 0.42 高于预测阈值 0.2，方向相反且越过容差带；golden 基准对照一致。",
  observed: { metric: "resource-utilization", resourceId: "sensor-station", value: 0.42 },
  generatedAt: "2026-09-28T10:00:00.000Z",
  evidence: [],
};

const dataQuerySource: DataQuerySource = {
  listDatasets: () => [],
  getDataset: () => undefined,
  readDataset: async () => ({ dataset: undefined as never, fields: [], rows: [] }),
};

async function runtime(options: { audit: AiReliabilityAuditBuffer }) {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-harness-int-"));
  dataDirs.push(dir);
  const memory = new AgentMemoryStore(dir);
  await memory.init();
  const rulesPath = memory.rulesPath("project-1");
  await mkdir(path.dirname(rulesPath), { recursive: true });
  const guards = createAgentHarnessGuards({ audit: options.audit.sink, memory, calibrationResourceIds: ["sensor-station"] });
  const capturedInputs: Array<{ context: Record<string, unknown>; inputChars: number }> = [];
  const registry = new PluginRegistry({
    apiVersion: "1.0", sceneApiVersion: "1.0", host: "cloud", renderer: "webgl2",
    capabilities: ["ai.provider", "data.query"], permissions: ["ai.invoke", "data.read"],
    extensionPoints: ["ai.provider", "capability.provider"], allowTrustedSceneExtensions: false,
  });
  let round = 0;
  const registered = registry.register({
    schemaVersion: 1, id: "test.ai", name: "Harness QA planner", version: "1.0.0", apiVersion: "1.0", hosts: ["cloud"],
    capabilities: ["ai.provider"], permissions: ["ai.invoke"],
    extensionPoints: [{ kind: "ai.provider", id: "test.runtime", providerIds: ["ai.test"], execution: "in-process", limits: { timeoutMs: 1_000, maxInputBytes: 1_000_000, memoryMb: 32 } }],
  }, ({ registerAiProvider }) => registerAiProvider({
    descriptor: { id: "ai.test", version: "1.0.0", label: "Test planner", execution: "in-process", permissions: ["ai.invoke"], streaming: false, timeoutMs: 1_000 },
    async complete(request) {
      const parsed = JSON.parse(request.input) as { context: Record<string, unknown> };
      capturedInputs.push({ context: parsed.context, inputChars: request.input.length });
      if (round === 0) {
        round += 1;
        // 第一轮：登记假设（合法，放行）→ 调 golden.verify（由网关直通 mock 执行? 不走 capability，
        // 改为第一轮直接 call-tool verify，由测试网关返回 envelope）。
        return { text: JSON.stringify({
          kind: "call-tool", rationale: "验证假设",
          call: { toolId: "simulation.golden.verify", arguments: { hypothesis: {
            hypothesisVersion: "1", id: "h-utilization", statement: "利用率低于 0.2",
            targetModel: "t23-conveyor-sensor-agv",
            prediction: { metric: "resource-utilization", resourceId: "sensor-station", comparator: "less-than", expected: 0.2 },
            tolerance: { absolute: 0.05 },
          } }, resources: [{ kind: "project", id: "project-1" }] },
        }), model: "qa" };
      }
      // 第二轮：读完上轮结论后收尾。
      return { text: JSON.stringify({ kind: "finish", rationale: "已有上轮结论", summary: "引用上轮 verdict", decisionStatus: "shadow", evidenceIds: [] }), model: "qa" };
    },
  }));
  expect(registered.ok).toBe(true);
  expect((await registry.enable("test.ai")).ok).toBe(true);
  // 测试网关：golden.verify 直接返回预置 envelope（内核判定已由 H-C1 golden 测试覆盖）。
  const tools = {
    list: () => [{
      id: "simulation.golden.verify", label: "校准验证", description: "verify", effect: "analyze" as const, risk: "low" as const, requiresApproval: false,
    }],
    fingerprint: (call: { toolId: string; arguments: unknown }) => fingerprint64Labeled([["fp", { toolId: call.toolId, arguments: call.arguments }]]),
    execute: async () => ({ status: "completed" as const, output: VERIFIED_ENVELOPE, evidence: [], verificationEvidence: [] }),
  };
  const decisions = createIndustrialAgentDecisionProvider({
    registry,
    dataSource: dataQuerySource,
    settings: () => ({ providerId: "ai.test", model: "qa", protocol: "responses", baseUrl: "https://example.test", apiKey: "qa", temperature: 0 }),
    audit: options.audit.sink,
    memory: (projectId) => memory.loadDelivery(projectId),
  });
  const orchestrator = new IndustrialAgentOrchestrator({ decisions, tools, checkpoints: new MemoryAgentCheckpointStore(), guards });
  return { orchestrator, memory, capturedInputs, audit: options.audit, rulesPath };
}

function inputAssessments(audit: AiReliabilityAuditBuffer) {
  return audit.list().filter((event) => event.stage === "input-assessment");
}

describe("H-C2 回灌闭环（post-execute → 下一轮上下文 → 逐源审计）", () => {
  it("第二轮 run 的上下文含上轮 verdict 摘要（含 proposal/result 指纹与 refuted 结论）", async () => {
    const audit = new AiReliabilityAuditBuffer();
    const { orchestrator, capturedInputs } = await runtime({ audit });
    const first = await orchestrator.start({ projectId: "project-1", principal: "operator", objective: "验证利用率假设", allowedToolIds: ["simulation.golden.verify"] });
    expect(first.status).toBe("completed");
    expect(first.toolRecords[0]?.outcome.output).toMatchObject({ proposalFingerprint: "0123456789abcdef" });
    const second = await orchestrator.start({ projectId: "project-1", principal: "operator", objective: "基于上轮结论再验证", allowedToolIds: ["simulation.golden.verify"] });
    expect(second.status).toBe("completed");
    expect(capturedInputs.length).toBeGreaterThanOrEqual(3);
    const firstRoundContext = capturedInputs[0]?.context ?? {};
    expect(firstRoundContext.agentMemoryContext).toBeUndefined();
    const later = capturedInputs[capturedInputs.length - 1]?.context ?? {};
    const memoryContext = later.agentMemoryContext as {
      priorVerdicts?: Array<{ proposalFingerprint: string; resultFingerprint: string; verdict: string; reasonCode: string }>;
      memories?: Array<{ content: string }>;
    };
    expect(memoryContext?.priorVerdicts?.[0]).toMatchObject({
      proposalFingerprint: "0123456789abcdef",
      resultFingerprint: "23456789abcdef01",
      verdict: "refuted",
      reasonCode: "prediction-outside-tolerance",
    });
    // refuted 结论已作为候选记忆出现在上下文（用户确认后进 memories 源；pending 候选只在面板可见）。
    expect(memoryContext?.memories).toBeUndefined();
  });

  it("refuted 候选经用户确认后进入下一轮注入（规则>记忆优先级声明在场）", async () => {
    const audit = new AiReliabilityAuditBuffer();
    const { orchestrator, memory, capturedInputs } = await runtime({ audit });
    await orchestrator.start({ projectId: "project-1", principal: "operator", objective: "验证利用率假设", allowedToolIds: ["simulation.golden.verify"] });
    const [candidate] = await memory.listMemories("project-1");
    expect(candidate?.status).toBe("pending");
    await memory.confirmMemory("project-1", candidate!.id, "chief-engineer");
    await writeFile(memory.rulesPath("project-1"), "# 项目守则\n1. 一切结论必须引用三指纹。", "utf8");
    capturedInputs.length = 0;
    await orchestrator.start({ projectId: "project-1", principal: "operator", objective: "再次验证", allowedToolIds: ["simulation.golden.verify"] });
    const context = capturedInputs[0]?.context ?? {};
    const memoryContext = context.agentMemoryContext as {
      priority: string;
      rules?: string;
      memories?: Array<{ content: string }>;
    };
    expect(memoryContext?.priority).toBe("rules-over-memories");
    expect(memoryContext?.rules).toContain("一切结论必须引用三指纹");
    expect(memoryContext?.memories?.[0]?.content).toContain("被内核反驳");
  });

  it("逐源投递审计：RULES/记忆/结论各一条 finding，指纹与注入内容一致；确认与删除有 memory-action 审计", async () => {
    const audit = new AiReliabilityAuditBuffer();
    const { orchestrator, memory } = await runtime({ audit });
    await orchestrator.start({ projectId: "project-1", principal: "operator", objective: "验证利用率假设", allowedToolIds: ["simulation.golden.verify"] });
    const [candidate] = await memory.listMemories("project-1");
    await memory.confirmMemory("project-1", candidate!.id, "chief-engineer");
    await writeFile(memory.rulesPath("project-1"), "# 项目守则\n1. 结论必须引用三指纹。", "utf8");
    await orchestrator.start({ projectId: "project-1", principal: "operator", objective: "再次验证", allowedToolIds: ["simulation.golden.verify"] });
    const lastAssessment = inputAssessments(audit).at(-1)!;
    const sourceFindings = lastAssessment.findings.filter((finding) => finding.code.startsWith("context-source:"));
    expect(sourceFindings.map((finding) => finding.code).sort()).toEqual([
      "context-source:agent-memories",
      "context-source:prior-verdicts",
      "context-source:rules-md",
    ]);
    for (const finding of sourceFindings) expect(finding.contentFingerprint).toMatch(/^[0-9a-f]{16}$/);
    // memory-action 审计由记忆路由发（store 层不发），见 agentMemoryRoutes.test.ts。
    const afterDeletion = await memory.deleteMemory("project-1", candidate!.id).then(() => memory.loadDelivery("project-1"));
    expect(afterDeletion.memories).toHaveLength(0);
  });

  it("未配置记忆时注入为零：上下文无 agentMemoryContext 字段、审计无 context-source finding（零开销）", async () => {
    const audit = new AiReliabilityAuditBuffer();
    const { orchestrator, capturedInputs } = await runtime({ audit });
    // 不写 RULES、不产生 verdict：直接跑一个纯 finish run。
    capturedInputs.length = 0;
    const done = await orchestrator.start({ projectId: "project-empty", principal: "operator", objective: "只读盘点", allowedToolIds: ["simulation.golden.verify"] });
    void done;
    const context = capturedInputs[0]?.context ?? {};
    expect(context.agentMemoryContext).toBeUndefined();
    const assessments = inputAssessments(audit).filter((event) => event.projectId === "project-empty");
    expect(assessments.length).toBeGreaterThan(0);
    for (const event of assessments) {
      expect(event.findings.some((finding) => finding.code.startsWith("context-source:"))).toBe(false);
    }
  });

  it("注入后整体上下文仍在 agent 预算内（assertAgentContextBudget 未抛）", async () => {
    const audit = new AiReliabilityAuditBuffer();
    const { orchestrator } = await runtime({ audit });
    await orchestrator.start({ projectId: "project-1", principal: "operator", objective: "预算内验证", allowedToolIds: ["simulation.golden.verify"] });
    const second = await orchestrator.start({ projectId: "project-1", principal: "operator", objective: "预算内再验证", allowedToolIds: ["simulation.golden.verify"] });
    expect(second.status).toBe("completed");
  });
});
