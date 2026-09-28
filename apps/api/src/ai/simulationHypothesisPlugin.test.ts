import { describe, expect, it } from "vitest";
import { createHypothesisRegisterProvider, createGoldenVerifyProvider, registerAiHypothesisPlugin } from "./simulationHypothesisPlugin.js";
import { AiReliabilityAuditBuffer } from "./aiReliabilityAudit.js";
import { IndustrialAgentToolGateway } from "./industrialAgentToolGateway.js";
import { CALIBRATION_GOLDEN_HASH } from "@bim-studio/plant-lite-simulation";
import type { CapabilityProvider, PluginRegistry } from "@bim-studio/plugin-runtime";
import type { AgentCheckpoint, AgentToolCall } from "@bim-studio/industrial-agent-orchestrator";
import type { AiVerificationEnvelope } from "@bim-studio/contracts";

/**
 * 实测锚（T23 校准 golden `cf20cfbd6e97a617` 逐位复现时的真实指标，2026-09-28）：
 * resourceUtilization95: conveyor 0.0595 / sensor-unit 0.0952 / agv-fleet 0.1685。
 * 正例阈值 0.3（0.0952 < 0.3-0.05 → confirmed），反例阈值 0.9（→ refuted）。
 */
const POSITIVE_HYPOTHESIS = {
  hypothesisVersion: "1",
  id: "hyp-positive-sensor-idle",
  statement: "校准场景中传感器单元利用率低于 0.3",
  targetModel: "t23-conveyor-sensor-agv",
  prediction: { metric: "resource-utilization", resourceId: "sensor-unit", comparator: "less-than", expected: 0.3 },
  tolerance: { absolute: 0.05 },
};

const NEGATIVE_HYPOTHESIS = {
  hypothesisVersion: "1",
  id: "hyp-negative-sensor-busy",
  statement: "校准场景中传感器单元利用率高于 0.9",
  targetModel: "t23-conveyor-sensor-agv",
  prediction: { metric: "resource-utilization", resourceId: "sensor-unit", comparator: "greater-than", expected: 0.9 },
  tolerance: { absolute: 0.05 },
};

async function invoke(provider: CapabilityProvider<{ hypothesis: unknown }>, hypothesis: unknown) {
  return provider.invoke({
    requestId: "request-test",
    projectId: "project-1",
    principal: "tester",
    input: { hypothesis },
  }, { pluginId: "test", pluginVersion: "1.0.0", descriptor: provider.descriptor, signal: new AbortController().signal });
}

function asEnvelope(output: unknown): AiVerificationEnvelope {
  return output as AiVerificationEnvelope;
}

describe("simulation.hypothesis.register（analyze/low，不执行）", () => {
  it("登记合法假设并返回 16 位 proposalFingerprint，明确不执行", async () => {
    const provider = createHypothesisRegisterProvider();
    const result = await invoke(provider, POSITIVE_HYPOTHESIS);
    expect(result.status).toBe("completed");
    expect(result.decisionStatus).toBe("research-candidate");
    const output = result.output as { proposalFingerprint: string; execution: string; hypothesis: { id: string } };
    expect(output.proposalFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(output.execution).toBe("not-performed");
    expect(output.nextStep).toBe("simulation.golden.verify");
    expect(output.hypothesis.id).toBe("hyp-positive-sensor-idle");
  });

  it("非法合同 fail-closed：白名单外指标被拒且理由码回给提案者", async () => {
    const provider = createHypothesisRegisterProvider();
    const result = await invoke(provider, { ...POSITIVE_HYPOTHESIS, prediction: { ...POSITIVE_HYPOTHESIS.prediction, metric: "profit-margin" } });
    expect(result.status).toBe("blocked");
    expect(result.decisionStatus).toBe("insufficient-data");
    expect(result.warnings?.[0]).toContain("prediction.metric");
  });
});

describe("simulation.golden.verify（校准 golden 对照裁决）", () => {
  it("正例假设 → confirmed，verdict 含 proposal/input/result 三指纹且 golden 一致", async () => {
    const provider = createGoldenVerifyProvider();
    const result = await invoke(provider, POSITIVE_HYPOTHESIS);
    expect(result.status).toBe("completed");
    const envelope = asEnvelope(result.output);
    expect(envelope.verdict).toBe("confirmed");
    expect(envelope.reasonCode).toBe("prediction-within-tolerance");
    expect(envelope.proposalFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(envelope.inputFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(envelope.resultFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(envelope.goldenHash).toBe(CALIBRATION_GOLDEN_HASH);
    expect(envelope.goldenMatch).toBe(true);
    expect(envelope.observed).toMatchObject({ metric: "resource-utilization", resourceId: "sensor-unit" });
    expect(envelope.observed!.value).toBeGreaterThan(0);
    expect(envelope.observed!.value).toBeLessThan(0.25);
    expect(envelope.evidence.map((item) => item.id)).toEqual(
      expect.arrayContaining([envelope.resultFingerprint, envelope.goldenHash!, envelope.proposalFingerprint]),
    );
  });

  it("反例假设 → refuted，同一输入的 resultFingerprint 与正例一致（确定性）而 proposal 指纹不同", async () => {
    const provider = createGoldenVerifyProvider();
    const positive = asEnvelope((await invoke(provider, POSITIVE_HYPOTHESIS)).output);
    const negative = asEnvelope((await invoke(provider, NEGATIVE_HYPOTHESIS)).output);
    expect(negative.verdict).toBe("refuted");
    expect(negative.reasonCode).toBe("prediction-outside-tolerance");
    expect(negative.resultFingerprint).toBe(positive.resultFingerprint);
    expect(negative.proposalFingerprint).not.toBe(positive.proposalFingerprint);
    expect(negative.observed?.value).toBe(positive.observed?.value);
  });

  it("语义预检：目标场景不存在的资源被拒（拒绝在进入内核之前）", async () => {
    const provider = createGoldenVerifyProvider();
    const result = await invoke(provider, {
      ...POSITIVE_HYPOTHESIS,
      prediction: { ...POSITIVE_HYPOTHESIS.prediction, resourceId: "nonexistent-robot" },
    });
    expect(result.status).toBe("blocked");
    expect(result.warnings?.[0]).toContain("semantic-admission");
  });

  it("同一假设重复验证指纹逐位一致（可复现）", async () => {
    const provider = createGoldenVerifyProvider();
    const first = asEnvelope((await invoke(provider, POSITIVE_HYPOTHESIS)).output);
    const second = asEnvelope((await invoke(provider, POSITIVE_HYPOTHESIS)).output);
    expect(second.resultFingerprint).toBe(first.resultFingerprint);
    expect(second.inputFingerprint).toBe(first.inputFingerprint);
    expect(second.proposalFingerprint).toBe(first.proposalFingerprint);
  });
});

describe("两个能力接入 PluginRegistry 与 CURATED 白名单", () => {
  it("独立插件注册后 registry 可见，gateway 白名单暴露 read/analyze 效果定义", async () => {
    const registry = { register: () => undefined } as unknown as PluginRegistry;
    const host = new FakeRegistryHost();
    await registerAiHypothesisPlugin(host.registry);
    const ids = host.registry.listCapabilities().map((item) => item.id);
    expect(ids).toContain("simulation.hypothesis.register");
    expect(ids).toContain("simulation.golden.verify");
    const gateway = new IndustrialAgentToolGateway(host.registry);
    const tools = gateway.list().filter((tool) => tool.id.startsWith("simulation.hypothesis") || tool.id === "simulation.golden.verify");
    expect(tools.map((tool) => [tool.id, tool.effect, tool.risk]).sort((left, right) => left[0].localeCompare(right[0]))).toEqual([
      ["simulation.golden.verify", "analyze", "low"],
      ["simulation.hypothesis.register", "analyze", "low"],
    ]);
  });
});

describe("verdict 落 aiReliabilityAudit（经网关执行路径）", () => {
  it("golden.verify 完成后审计出现 verdict/reason findings 与三指纹，register 无 verdict 事件", async () => {
    const buffer = new AiReliabilityAuditBuffer();
    const host = new FakeRegistryHost();
    await registerAiHypothesisPlugin(host.registry);
    const gateway = new IndustrialAgentToolGateway(host.registry, buffer.sink);
    const checkpoint = fakeCheckpoint();
    const call: AgentToolCall = {
      toolId: "simulation.golden.verify",
      arguments: { hypothesis: POSITIVE_HYPOTHESIS },
      resources: [{ kind: "project", id: "project-1" }],
    };
    const outcome = await gateway.execute(call, { checkpoint, signal: new AbortController().signal });
    expect(outcome.status).toBe("completed");
    const events = buffer.list();
    // 四阶段既有事件（tool-decision/tool-result）之外，出现含 verdict findings 的 tool-result 事件。
    const verdictEvents = events.filter((event) => event.findings.some((finding) => finding.code.startsWith("verdict:")));
    expect(verdictEvents).toHaveLength(1);
    const verdictEvent = verdictEvents[0]!;
    expect(verdictEvent.stage).toBe("tool-result");
    expect(verdictEvent.findings.map((finding) => finding.code)).toEqual(["verdict:confirmed", "reason:prediction-within-tolerance"]);
    expect(verdictEvent.tool?.resourceFingerprints).toEqual([
      expect.stringMatching(/^[0-9a-f]{16}$/),
      expect.stringMatching(/^[0-9a-f]{16}$/),
      expect.stringMatching(/^[0-9a-f]{16}$/),
    ]);
    // 假设陈述原文不入审计（证据最小化）。
    expect(JSON.stringify(events)).not.toContain("传感器单元利用率");
  });
});

/** plan 档执行层硬拒（双重防线的第二道）：simulate 越界 → blocked + denied 审计事件。 */
describe("gateway plan 档硬拒与审计", () => {
  it("planMode 下 simulate 调用被拒（plan-mode-tool-not-allowed）并落 denied 审计，read/analyze 放行", async () => {
    const buffer = new AiReliabilityAuditBuffer();
    const host = new FakeRegistryHost();
    await registerAiHypothesisPlugin(host.registry);
    host.registerSimulateCapability("simulation.virtual-debug.run");
    const gateway = new IndustrialAgentToolGateway(host.registry, buffer.sink);
    const checkpoint = { ...fakeCheckpoint(), planMode: true };

    const simulateCall: AgentToolCall = {
      toolId: "simulation.virtual-debug.run",
      arguments: {},
      resources: [{ kind: "project", id: "project-1" }],
    };
    const deniedOutcome = await gateway.execute(simulateCall, { checkpoint, signal: new AbortController().signal });
    expect(deniedOutcome.status).toBe("blocked");
    expect(deniedOutcome.error?.code).toBe("plan-mode-tool-not-allowed");

    const analyzeCall: AgentToolCall = {
      toolId: "simulation.hypothesis.register",
      arguments: { hypothesis: POSITIVE_HYPOTHESIS },
      resources: [{ kind: "project", id: "project-1" }],
    };
    const allowedOutcome = await gateway.execute(analyzeCall, { checkpoint, signal: new AbortController().signal });
    expect(allowedOutcome.status).toBe("completed");

    const denialEvents = buffer.list().filter((event) => event.failure?.code === "plan-mode-tool-not-allowed");
    expect(denialEvents).toHaveLength(1);
    expect(denialEvents[0]).toMatchObject({ stage: "tool-decision", outcome: "denied", projectId: "project-1" });
    expect(denialEvents[0].tool?.id).toBe("simulation.virtual-debug.run");

    // 非 plan 模式同一 simulate 调用正常执行（开关语义只作用于计划运行）。
    const normalOutcome = await gateway.execute(simulateCall, { checkpoint: fakeCheckpoint(), signal: new AbortController().signal });
    expect(normalOutcome.status).toBe("completed");
  });
});

/** 测试用最小 PluginRegistry 假体：直接复用真实注册逻辑的登记面。 */
class FakeRegistryHost {
  readonly #providers = new Map<string, CapabilityProvider<never>>();
  readonly #simulateOutputs = new Map<string, () => unknown>();
  readonly registry = {
    register: (manifest: unknown, factory: (api: { registerCapability: (provider: CapabilityProvider<never>) => { ok: boolean; message?: string } }) => void) => {
      factory({
        registerCapability: (provider) => {
          this.#providers.set(provider.descriptor.id, provider);
          return { ok: true };
        },
      });
      return { ok: true };
    },
    enable: async () => ({ ok: true }),
    listCapabilities: () => [...this.#providers.values()].map((provider) => structuredClone(provider.descriptor)),
    getCapability: (id: string) => {
      const provider = this.#providers.get(id);
      return provider ? structuredClone(provider.descriptor) : undefined;
    },
    invokeCapability: async (id: string, request: { input: unknown }) => {
      const simulate = this.#simulateOutputs.get(id);
      if (simulate) {
        return {
          status: "completed",
          capabilityId: id,
          pluginId: "test",
          capabilityVersion: "1.0.0",
          requestId: "gateway-test",
          traceId: "trace-test",
          generatedAt: new Date().toISOString(),
          durationMs: 1,
          decisionStatus: "production",
          output: simulate(),
          evidence: [{ id: "sim-evidence", kind: "simulation", label: "仿真输出", source: "model:test", fingerprint: "aaaaaaaaaaaaaaaa" }],
          warnings: [],
          suggestedActions: [],
        };
      }
      const provider = this.#providers.get(id) as CapabilityProvider<{ hypothesis: unknown }> | undefined;
      if (!provider) throw new Error(`未注册能力：${id}`);
      const result = await provider.invoke({
        requestId: "gateway-test",
        projectId: request.projectId,
        principal: "tester",
        input: request.input,
      }, { pluginId: "test", pluginVersion: "1.0.0", descriptor: provider.descriptor, signal: new AbortController().signal });
      return {
        status: result.status,
        capabilityId: id,
        pluginId: "test",
        capabilityVersion: "1.0.0",
        requestId: "gateway-test",
        traceId: "trace-test",
        generatedAt: new Date().toISOString(),
        durationMs: 1,
        decisionStatus: result.decisionStatus,
        ...(result.output !== undefined ? { output: result.output } : {}),
        evidence: (result.evidence ?? []).map((item) => ({ ...item })),
        warnings: result.warnings ?? [],
        suggestedActions: [],
      };
    },
  } as unknown as PluginRegistry;

  /** 注册一个 simulate 假能力，用于 plan 档越界拒绝测试。 */
  registerSimulateCapability(id: string): void {
    this.#simulateOutputs.set(id, () => ({ status: "passed" }));
    this.#providers.set(id, {
      descriptor: {
        id,
        version: "1.0.0",
        label: "虚拟调试回放",
        kind: "simulation",
        execution: "in-process",
        permissions: ["simulation.execute"],
        timeoutMs: 30_000,
        inputSchemaVersion: "1.0",
        outputSchemaVersion: "1.0",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        outputSchema: { type: "object", additionalProperties: true },
      },
      invoke: async () => ({ status: "completed", decisionStatus: "production" }),
    } as CapabilityProvider<never>);
  }
}

function fakeCheckpoint(): AgentCheckpoint {
  return {
    schemaVersion: 1,
    id: "run-test",
    projectId: "project-1",
    principal: "tester",
    role: "editor",
    objective: "验证假设回路",
    context: {},
    status: "running",
    budget: { maxSteps: 8, maxDurationMs: 120_000, maxToolCalls: 6 },
    usage: { steps: 1, toolCalls: 0, activeDurationMs: 0 },
    allowedToolIds: ["simulation.golden.verify"],
    decisions: [],
    toolRecords: [],
    seenToolFingerprints: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revision: 1,
  };
}
