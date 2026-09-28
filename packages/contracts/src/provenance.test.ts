import { describe, expect, it } from "vitest";
import type { AiHypothesisContract, AiVerificationEnvelope } from "./aiHypothesis.js";
import { aiHypothesisProposalFingerprint } from "./aiHypothesis.js";
import {
  AI_PROVENANCE_CHAIN_VERSION,
  AiProvenanceContractError,
  assembleAiProvenanceTrace,
  buildAiProvenanceHypothesisNode,
  buildAiProvenanceKernelRunNode,
  buildAiProvenanceVerdictNode,
  provenanceDigest,
  provenanceVerdictIntegrityFingerprint,
  validateAiProvenanceQuery,
  type AiProvenanceRecords,
} from "./provenance.js";

export const HYPOTHESIS: AiHypothesisContract = {
  hypothesisVersion: "1",
  id: "hyp-archive-1",
  statement: "校准场景中传感器单元利用率低于 0.3",
  targetModel: "t23-conveyor-sensor-agv",
  prediction: { metric: "resource-utilization", resourceId: "sensor-unit", comparator: "less-than", expected: 0.3 },
  tolerance: { absolute: 0.05 },
};

export const ENVELOPE: AiVerificationEnvelope = {
  proposalFingerprint: aiHypothesisProposalFingerprint(HYPOTHESIS),
  inputFingerprint: "123456789abcdef0",
  resultFingerprint: "23456789abcdef01",
  verdict: "confirmed",
  tolerance: { absolute: 0.05 },
  reasonCode: "prediction-within-tolerance",
  rationale: "假设「传感器利用率低于 0.3」：实测 sensor-unit=0.095238，低于阈值 0.3，越过容差带；golden 基准对照一致。",
  observed: { metric: "resource-utilization", resourceId: "sensor-unit", value: 0.095238 },
  engineId: "plant-lite-des",
  goldenHash: "cf20cfbd6e97a617",
  goldenMatch: true,
  generatedAt: "2026-09-28T10:00:00.000Z",
  evidence: [],
};

export function singleChainRecords(): AiProvenanceRecords {
  const hypothesis = buildAiProvenanceHypothesisNode(HYPOTHESIS, ENVELOPE.proposalFingerprint, "2026-09-28T09:59:00.000Z");
    const run = buildAiProvenanceKernelRunNode(ENVELOPE, { seed: "t23-calibration-2026-09-27", replications: 12, executedAt: "2026-09-28T10:00:00.000Z" });
    const verdict = buildAiProvenanceVerdictNode(ENVELOPE, "2026-09-28T10:00:01.000Z");
    return { hypotheses: [hypothesis], runs: [run], verdicts: [verdict], reports: [] };
  }

describe("provenance 链合同（H-C3 档案室）", () => {
  it("节点构建：nodeId 取指纹口径，完整性指纹对全字段敏感", () => {
    const records = singleChainRecords();
    expect(records.hypotheses[0].nodeId).toBe(ENVELOPE.proposalFingerprint);
    expect(records.runs[0].nodeId).toBe(ENVELOPE.resultFingerprint);
    expect(records.runs[0].seed).toBe("t23-calibration-2026-09-27");
    expect(records.verdicts[0].nodeId).toBe(`verdict:${ENVELOPE.resultFingerprint}`);
    expect(records.verdicts[0].integrityFingerprint).toMatch(/^[0-9a-f]{16}$/);

    const tampered = { ...records.verdicts[0], verdict: "refuted" as const };
    const { integrityFingerprint, ...rest } = tampered;
    expect(provenanceVerdictIntegrityFingerprint(rest)).not.toBe(integrityFingerprint);
  });

  it("三跳装配：假设→运行→判定成链，边与完整性如实", () => {
    const trace = assembleAiProvenanceTrace(singleChainRecords(), { resultFingerprint: ENVELOPE.resultFingerprint });
    expect(trace.matched).toBe(true);
    expect(trace.chains).toHaveLength(1);
    const chain = trace.chains[0];
    expect(chain.hypothesis.hypothesisId).toBe("hyp-archive-1");
    expect(chain.runs).toHaveLength(1);
    expect(chain.verdicts.map((node) => node.verdict)).toEqual(["confirmed"]);
    expect(chain.integrity).toBe("intact");
    expect(chain.breaks).toEqual([]);
    expect(chain.edges).toEqual([
      { from: ENVELOPE.proposalFingerprint, to: ENVELOPE.resultFingerprint, relation: "executed" },
      { from: ENVELOPE.resultFingerprint, to: `verdict:${ENVELOPE.resultFingerprint}`, relation: "judged" },
    ]);
  });

  it("未命中：无记录时 matched=false 且零链，不伪造", () => {
    const trace = assembleAiProvenanceTrace({ hypotheses: [], runs: [], verdicts: [], reports: [] }, { resultFingerprint: "23456789abcdef01" });
    expect(trace.matched).toBe(false);
    expect(trace.chains).toEqual([]);
  });

  it("跨 run 链：同假设两次不同结果运行各成一跳，时间序正确", () => {
    const base = singleChainRecords();
    const secondEnvelope = { ...ENVELOPE, resultFingerprint: "aaaaaaaaaaaaaaaa", verdict: "refuted" as const, reasonCode: "prediction-outside-tolerance" as const };
    base.runs.push(buildAiProvenanceKernelRunNode(secondEnvelope, { seed: "t23-calibration-2026-09-27", replications: 12, executedAt: "2026-09-28T11:00:00.000Z" }));
    base.verdicts.push(buildAiProvenanceVerdictNode(secondEnvelope, "2026-09-28T11:00:01.000Z"));
    const trace = assembleAiProvenanceTrace(base, { proposalFingerprint: ENVELOPE.proposalFingerprint });
    expect(trace.chains).toHaveLength(1);
    expect(trace.chains[0].runs.map((node) => node.resultFingerprint)).toEqual([ENVELOPE.resultFingerprint, "aaaaaaaaaaaaaaaa"]);
    expect(trace.chains[0].verdicts.map((node) => node.verdict)).toEqual(["confirmed", "refuted"]);
    expect(trace.chains[0].edges.filter((edge) => edge.relation === "executed")).toHaveLength(2);
  });

  it("篡改检测：改判定后完整性指纹不一致，链断如实暴露", () => {
    const records = singleChainRecords();
    records.verdicts[0] = { ...records.verdicts[0], verdict: "refuted" };
    const trace = assembleAiProvenanceTrace(records, {});
    expect(trace.integrity.intact).toBe(false);
    expect(trace.integrity.brokenNodes).toEqual([`verdict:${ENVELOPE.resultFingerprint}`]);
    expect(trace.chains[0].integrity).toBe("broken");
    expect(trace.chains[0].breaks[0].code).toBe("verdict-integrity-mismatch");
  });

  it("孤儿判定与缺运行：断链独立暴露，不静默丢节点", () => {
    const records = singleChainRecords();
    records.runs = [];
    const trace = assembleAiProvenanceTrace(records, {});
    expect(trace.integrity.intact).toBe(false);
    expect(trace.integrity.brokenNodes).toContain(`verdict:${ENVELOPE.resultFingerprint}`);
  });

  it("时间窗：since/until 作用于链上任何节点时点", () => {
    const records = singleChainRecords();
    expect(assembleAiProvenanceTrace(records, { since: "2026-09-28T09:00:00.000Z" }).matched).toBe(true);
    expect(assembleAiProvenanceTrace(records, { since: "2026-09-29T00:00:00.000Z" }).matched).toBe(false);
    expect(assembleAiProvenanceTrace(records, { until: "2026-09-27T00:00:00.000Z" }).matched).toBe(false);
  });

  it("查询校验 fail-closed：非法指纹/时间/limit 一律抛错", () => {
    expect(() => validateAiProvenanceQuery({ resultFingerprint: "nothex" })).toThrow(AiProvenanceContractError);
    expect(() => validateAiProvenanceQuery({ since: "2026-09-28" })).toThrow(AiProvenanceContractError);
    expect(() => validateAiProvenanceQuery({ limit: 0 })).toThrow(AiProvenanceContractError);
    expect(() => validateAiProvenanceQuery({ limit: 101 })).toThrow(AiProvenanceContractError);
    expect(() => validateAiProvenanceQuery({ since: "2026-09-28T10:00:00.000Z", until: "2026-09-27T10:00:00.000Z" })).toThrow(AiProvenanceContractError);
    expect(validateAiProvenanceQuery({ resultFingerprint: ENVELOPE.resultFingerprint, limit: 5 })).toEqual({
      resultFingerprint: ENVELOPE.resultFingerprint,
      limit: 5,
    });
  });

  it("摘要截断带显式标记；链版本字段落进 trace", () => {
    expect(provenanceDigest("a".repeat(301))).toContain("…[已截断]");
    expect(provenanceDigest("短陈述")).toBe("短陈述");
    const trace = assembleAiProvenanceTrace(singleChainRecords(), {});
    expect(trace.chainVersion).toBe(AI_PROVENANCE_CHAIN_VERSION);
  });
});
