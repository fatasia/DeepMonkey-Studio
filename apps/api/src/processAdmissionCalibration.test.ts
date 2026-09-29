import { describe, expect, it } from "vitest";
import {
  buildProcessAdmissionCalibrationCorpus,
  runProcessAdmissionCalibration,
  type ProcessAdmissionCalibrationCorpus,
} from "./processAdmissionCalibration.js";

function deepCloneCorpus(corpus: ProcessAdmissionCalibrationCorpus): ProcessAdmissionCalibrationCorpus {
  return structuredClone(corpus) as ProcessAdmissionCalibrationCorpus;
}

describe("独立校准集（训练/保留两分，保留集误差如实输出）", () => {
  it("语料两分完整：训练 6 例 / 保留 7 例，两分 ID 不相交，每例标签带出处", () => {
    const corpus = buildProcessAdmissionCalibrationCorpus();
    expect(corpus.training).toHaveLength(6);
    expect(corpus.holdout).toHaveLength(7);
    const trainingIds = new Set(corpus.training.map((calibrationCase) => calibrationCase.id));
    expect(corpus.holdout.every((calibrationCase) => !trainingIds.has(calibrationCase.id))).toBe(true);
    for (const calibrationCase of [...corpus.training, ...corpus.holdout]) {
      expect(calibrationCase.basis.trim()).not.toBe("");
      expect(calibrationCase.plan.versionId.trim()).not.toBe("");
    }
  });

  it("训练集校准：N8 表逐行正例全部命中（误差 0）", () => {
    const summary = runProcessAdmissionCalibration();
    expect(summary.training.total).toBe(6);
    expect(summary.training.errorCount).toBe(0);
    expect(summary.training.errorRate).toBe(0);
  });

  it("保留集校准：复合/边界用例全部命中（保留集误差 0，如实输出误差率）", () => {
    const summary = runProcessAdmissionCalibration();
    expect(summary.holdout.total).toBe(7);
    expect(summary.holdout.errorCount).toBe(0);
    expect(summary.holdout.errorRate).toBe(0);
    for (const result of summary.holdout.cases) {
      expect(result.mismatches).toEqual([]);
      expect(result.pass).toBe(true);
      expect(result.actualFormalPredictionAllowed).toBe(result.expectedFormalPredictionAllowed);
    }
  });

  it("误差通道真实传导（不粉饰）：篡改一个保留集期望后误差如实计为 1 且误差率 = 1/7", () => {
    const corpus = deepCloneCorpus(buildProcessAdmissionCalibrationCorpus());
    const target = corpus.holdout.find((calibrationCase) => calibrationCase.id === "H7-conditional-predecessor-still-join")!;
    target.expectation.formalPredictionAllowed = true;
    const summary = runProcessAdmissionCalibration(corpus);
    expect(summary.holdout.errorCount).toBe(1);
    expect(summary.holdout.errorRate).toBeCloseTo(1 / 7, 12);
    const failed = summary.holdout.cases.find((result) => result.caseId === "H7-conditional-predecessor-still-join")!;
    expect(failed.pass).toBe(false);
    expect(failed.mismatches.join(";")).toContain("formalPredictionAllowed");
  });

  it("确定性可重放：两次独立校准输出逐字节一致且语料指纹相等", () => {
    const first = runProcessAdmissionCalibration();
    const second = runProcessAdmissionCalibration();
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second.corpusFingerprint).toBe(first.corpusFingerprint);
    expect(second.corpusFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("语料指纹稳定且敏感：重复构建同指纹，篡改任一语料字段即变指纹", () => {
    const corpusA = buildProcessAdmissionCalibrationCorpus();
    const corpusB = buildProcessAdmissionCalibrationCorpus();
    expect(runProcessAdmissionCalibration(corpusB).corpusFingerprint).toBe(runProcessAdmissionCalibration(corpusA).corpusFingerprint);

    const tampered = deepCloneCorpus(corpusA);
    tampered.training[0]!.plan.operations[0]!.standardTimeMinutes = 6;
    expect(runProcessAdmissionCalibration(tampered).corpusFingerprint).not.toBe(runProcessAdmissionCalibration(corpusA).corpusFingerprint);
  });

  it("量化汇总：覆盖结构行 6、阻断用例 10、拒绝/占位结构行 12（direct 行不计拒绝），与语料期望逐项一致", () => {
    const summary = runProcessAdmissionCalibration();
    expect(summary.coveredStructures).toBe(6);
    expect(summary.rejectionCases).toBe(10);
    expect(summary.rejectionEntries).toBe(12);

    const corpus = buildProcessAdmissionCalibrationCorpus();
    const allCases = [...corpus.training, ...corpus.holdout];
    const covered = new Set(allCases.flatMap((calibrationCase) => calibrationCase.expectation.structures.map((row) => row.structure)));
    covered.add("sequential-flow");
    expect(summary.coveredStructures).toBe(covered.size);
    expect(summary.rejectionCases).toBe(allCases.filter((calibrationCase) => !calibrationCase.expectation.formalPredictionAllowed).length);
    expect(summary.rejectionEntries).toBe(
      allCases.reduce((count, calibrationCase) => count + calibrationCase.expectation.structures.filter((row) => row.verdict !== "direct").length, 0),
    );
  });
});
