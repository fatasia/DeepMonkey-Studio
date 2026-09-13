import { describe, expect, it } from "vitest";
import type { AiSampleResult } from "@bim-studio/contracts";
import { batterySuggestionDraft, sampleSuggestionDraft, suggestionCaseInput } from "./operationalSuggestionDraft";

const result: AiSampleResult = { schemaVersion: 1, runId: "run-1", projectId: "qa", kind: "energy", execution: "local-sample", engine: "local", inputFingerprint: "fingerprint", startedAt: "now", completedAt: "now", input: [], output: {}, metrics: [{ label: "能耗偏差", labelEn: "Deviation", value: "+60.0%" }] };
describe("evidence to reviewable operational suggestion", () => {
  it("keeps synthetic source, actual metrics and stable replay identity", () => {
    const draft = sampleSuggestionDraft(result);
    expect(draft.evidence).toContain("能耗偏差：+60.0%");
    expect(draft.title).toContain("样例");
    expect(sampleSuggestionDraft({ ...result, runId: "retry" }).reference).toBe(draft.reference);
    expect(suggestionCaseInput(draft, "已审阅建议", "核对空转\n\n复跑基线")).toMatchObject({ status: "triage", severity: "info", objectRefs: [], suggestedActions: ["核对空转", "复跑基线"] });
  });
  it("never labels ordinary sample vision targets as confirmed defects", () => {
    const draft = sampleSuggestionDraft({ ...result, kind: "vision" });
    expect(draft.title).toContain("识别复核");
    expect(draft.evidence).not.toContain("已确认缺陷");
    expect(() => sampleSuggestionDraft({ ...result, kind: "query" })).toThrow("查询计划");
  });
  it("rejects empty or excessive reviewed actions", () => {
    const draft = sampleSuggestionDraft(result);
    expect(() => suggestionCaseInput(draft, "", "核对")).toThrow("标题");
    expect(() => suggestionCaseInput(draft, "标题", " \n ")).toThrow("一条");
    expect(() => suggestionCaseInput(draft, "标题", Array(21).fill("检查").join("\n"))).toThrow("20 条");
  });
  it("retains battery source and finite output without inventing absent predictions", () => {
    const draft = batterySuggestionDraft({ projectId: "qa", task: "rul", result: { predictedCycleLife: 807, currentSoh: NaN }, source: "local-sample", reference: "request", sourceLabel: "合成充放电样例" });
    expect(draft.evidence).toEqual(["来源：合成充放电样例", "预计寿命：807.00 圈"]);
    expect(draft.sourceRefs).toContain("request");
    expect(draft.title).toContain("样例");
  });
  it("turns Pack aggregation into a weakest-cell review action", () => {
    const draft = batterySuggestionDraft({
      projectId: "qa", task: "soh", source: "local-sample", reference: "pack", sourceLabel: "96 电芯 Pack",
      result: { dataProfile: { packAssessment: { meanSohPct: 96.4, weakestSohPct: 86.8, sohSpreadPct: 10.4, weakestCellId: "C071", weakestModuleId: "M6" } } },
    });
    expect(draft.evidence).toContain("最弱电芯 SOH：86.80%");
    expect(draft.actions[0]).toContain("C071（M6）");
  });
});
