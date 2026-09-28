import { describe, expect, it } from "vitest";
import {
  AI_HYPOTHESIS_COMPARATORS,
  AI_HYPOTHESIS_METRICS,
  AI_HYPOTHESIS_TARGET_MODELS,
  aiHypothesisMetricLocator,
  aiHypothesisProposalFingerprint,
  evaluateAiHypothesis,
  validateAiHypothesisContract,
  validateAiVerificationEnvelope,
} from "./aiHypothesis.js";
import { fingerprint64Labeled } from "./fingerprint.js";

const VALID_CONTRACT = {
  hypothesisVersion: "1",
  id: "hyp-2026-09-28-sensor-idle",
  statement: "校准场景中传感器单元利用率低于 0.3（检测节拍远快于来料）",
  targetModel: "t23-conveyor-sensor-agv",
  prediction: { metric: "resource-utilization", resourceId: "sensor-unit", comparator: "less-than", expected: 0.3 },
  tolerance: { absolute: 0.05 },
} as const;

describe("aiHypothesis 合同校验（fail-closed）", () => {
  it("接受白名单内的合法合同并归一为严格形状", () => {
    const contract = validateAiHypothesisContract(VALID_CONTRACT);
    expect(contract).toEqual({
      hypothesisVersion: "1",
      id: "hyp-2026-09-28-sensor-idle",
      statement: VALID_CONTRACT.statement,
      targetModel: "t23-conveyor-sensor-agv",
      prediction: { metric: "resource-utilization", resourceId: "sensor-unit", comparator: "less-than", expected: 0.3 },
      tolerance: { absolute: 0.05 },
    });
  });

  it("拒绝白名单外的目标场景、指标与比较器", () => {
    expect(() => validateAiHypothesisContract({ ...VALID_CONTRACT, targetModel: "some-unnamed-plant" }))
      .toThrowError(/不在已注册白名单/);
    expect(() => validateAiHypothesisContract({ ...VALID_CONTRACT, prediction: { ...VALID_CONTRACT.prediction, metric: "profit-margin" } }))
      .toThrowError(/不在可裁决指标白名单/);
    expect(() => validateAiHypothesisContract({ ...VALID_CONTRACT, prediction: { ...VALID_CONTRACT.prediction, comparator: "equals" } }))
      .toThrowError(/less-than 或 greater-than/);
  });

  it("拒绝 resource-utilization 缺少 resourceId 的假设", () => {
    expect(() => validateAiHypothesisContract({
      ...VALID_CONTRACT,
      prediction: { metric: "resource-utilization", comparator: "less-than", expected: 0.3 },
    })).toThrowError(/prediction\.resourceId/);
  });

  it("拒绝非有限数、越域阈值与越域容差", () => {
    expect(() => validateAiHypothesisContract({ ...VALID_CONTRACT, prediction: { ...VALID_CONTRACT.prediction, expected: Number.NaN } }))
      .toThrowError(/有限数字/);
    expect(() => validateAiHypothesisContract({ ...VALID_CONTRACT, prediction: { ...VALID_CONTRACT.prediction, expected: 1.5 } }))
      .toThrowError(/0 至 1 之间/);
    expect(() => validateAiHypothesisContract({ ...VALID_CONTRACT, prediction: { metric: "throughput-per-hour", comparator: "greater-than", expected: -1 } }))
      .toThrowError(/正数/);
    expect(() => validateAiHypothesisContract({ ...VALID_CONTRACT, tolerance: { absolute: -0.01 } }))
      .toThrowError(/非负有限数字/);
    expect(() => validateAiHypothesisContract({ ...VALID_CONTRACT, tolerance: { absolute: 9 } }))
      .toThrowError(/不得超过/);
  });

  it("拒绝缺失或越界的基础字段与错误版本", () => {
    expect(() => validateAiHypothesisContract({ ...VALID_CONTRACT, hypothesisVersion: "2" })).toThrowError(/版本/);
    expect(() => validateAiHypothesisContract({ ...VALID_CONTRACT, id: "  " })).toThrowError(/id 不能为空/);
    expect(() => validateAiHypothesisContract({ ...VALID_CONTRACT, id: "x".repeat(201) })).toThrowError(/超过 200 字符/);
    expect(() => validateAiHypothesisContract({ ...VALID_CONTRACT, statement: "" })).toThrowError(/statement 不能为空/);
    expect(() => validateAiHypothesisContract(null)).toThrowError(/hypothesis 必须是对象/);
    expect(() => validateAiHypothesisContract([VALID_CONTRACT])).toThrowError(/必须是对象/);
  });

  it("白名单常量保持可枚举且覆盖本切片声明的口径", () => {
    expect(AI_HYPOTHESIS_TARGET_MODELS).toEqual(["t23-conveyor-sensor-agv"]);
    expect(AI_HYPOTHESIS_METRICS).toContain("resource-utilization");
    expect(AI_HYPOTHESIS_COMPARATORS).toEqual(["less-than", "greater-than"]);
  });
});

describe("aiHypothesis 指纹（唯一来源 fingerprint64Labeled）", () => {
  it("同输入恒同指纹，任一字段变化即改变指纹", () => {
    const contract = validateAiHypothesisContract(VALID_CONTRACT);
    const again = validateAiHypothesisContract({ ...VALID_CONTRACT });
    const variant = validateAiHypothesisContract({ ...VALID_CONTRACT, prediction: { ...VALID_CONTRACT.prediction, expected: 0.35 } });
    expect(aiHypothesisProposalFingerprint(contract)).toBe(aiHypothesisProposalFingerprint(again));
    expect(aiHypothesisProposalFingerprint(contract)).not.toBe(aiHypothesisProposalFingerprint(variant));
    expect(aiHypothesisProposalFingerprint(contract)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("指纹与合同内容一一对应（防字段拼接近似碰撞的标注指纹）", () => {
    const contract = validateAiHypothesisContract(VALID_CONTRACT);
    expect(aiHypothesisProposalFingerprint(contract)).toBe(fingerprint64Labeled([["ai-hypothesis", "1"], ["contract", contract]]));
  });

  it("指标定位在带资源与不带资源两种形态下拼写稳定", () => {
    expect(aiHypothesisMetricLocator(validateAiHypothesisContract(VALID_CONTRACT).prediction)).toBe("resource-utilization:sensor-unit");
    expect(aiHypothesisMetricLocator({ metric: "throughput-per-hour", comparator: "greater-than", expected: 10 })).toBe("throughput-per-hour");
  });
});

describe("evaluateAiHypothesis 确定性裁决（提案者不参与裁决）", () => {
  const prediction = { metric: "resource-utilization" as const, resourceId: "sensor-unit", comparator: "less-than" as const, expected: 0.3 };
  const tolerance = { absolute: 0.05 };

  it("越过容差带且方向成立 → confirmed", () => {
    expect(evaluateAiHypothesis({ prediction, tolerance, observed: 0.15 })).toEqual({ verdict: "confirmed", reasonCode: "prediction-within-tolerance" });
  });

  it("越过容差带且方向相反 → refuted", () => {
    expect(evaluateAiHypothesis({ prediction, tolerance, observed: 0.9 })).toEqual({ verdict: "refuted", reasonCode: "prediction-outside-tolerance" });
  });

  it("容差带内 → inconclusive（不强行归边）", () => {
    expect(evaluateAiHypothesis({ prediction, tolerance, observed: 0.28 })).toEqual({ verdict: "inconclusive", reasonCode: "prediction-in-tolerance-band" });
    expect(evaluateAiHypothesis({ prediction, tolerance, observed: 0.32 })).toEqual({ verdict: "inconclusive", reasonCode: "prediction-in-tolerance-band" });
  });

  it("greater-than 方向语义对称", () => {
    const greater = { ...prediction, comparator: "greater-than" as const };
    expect(evaluateAiHypothesis({ prediction: greater, tolerance, observed: 0.9 }).verdict).toBe("confirmed");
    expect(evaluateAiHypothesis({ prediction: greater, tolerance, observed: 0.15 }).verdict).toBe("refuted");
  });
});

describe("aiVerificationEnvelope 校验（三指纹 fail-closed）", () => {
  const baseEnvelope = {
    proposalFingerprint: "0123456789abcdef",
    inputFingerprint: "123456789abcdef0",
    resultFingerprint: "23456789abcdef01",
    verdict: "confirmed",
    tolerance: { absolute: 0.05 },
    reasonCode: "prediction-within-tolerance",
    rationale: "观测值 0.152 低于阈值 0.3 且越过容差带",
    observed: { metric: "resource-utilization", resourceId: "sensor-unit", value: 0.152 },
    engineId: "plant-lite-des",
    goldenHash: "cf20cfbd6e97a617",
    goldenMatch: true,
    generatedAt: "2026-09-28T10:00:00.000Z",
    evidence: [{ id: "ev-1", kind: "simulation", label: "校准基准运行", source: "model:t23-conveyor-sensor-agv", fingerprint: "3456789abcdef012" }],
  };

  it("接受齐备的信封并保留全部字段", () => {
    const envelope = validateAiVerificationEnvelope(baseEnvelope);
    expect(envelope.verdict).toBe("confirmed");
    expect(envelope.goldenMatch).toBe(true);
    expect(envelope.evidence).toHaveLength(1);
  });

  it("拒绝缺失或格式非法的三指纹", () => {
    expect(() => validateAiVerificationEnvelope({ ...baseEnvelope, proposalFingerprint: "short" })).toThrowError(/proposalFingerprint/);
    expect(() => validateAiVerificationEnvelope({ ...baseEnvelope, inputFingerprint: "ABCDEF0123456789" })).toThrowError(/inputFingerprint/);
    expect(() => validateAiVerificationEnvelope({ ...baseEnvelope, resultFingerprint: undefined })).toThrowError(/resultFingerprint/);
  });

  it("拒绝白名单外 verdict、理由码与坏时间；非有限观测值按缺省处理", () => {
    expect(() => validateAiVerificationEnvelope({ ...baseEnvelope, verdict: "probably" })).toThrowError(/verdict/);
    expect(() => validateAiVerificationEnvelope({ ...baseEnvelope, reasonCode: "looks-fine" })).toThrowError(/理由码/);
    expect(() => validateAiVerificationEnvelope({ ...baseEnvelope, generatedAt: "not-a-date" })).toThrowError(/generatedAt/);
    expect(validateAiVerificationEnvelope({ ...baseEnvelope, observed: { metric: "resource-utilization", value: Number.NaN } }).observed).toBeUndefined();
  });
});
