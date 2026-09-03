import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { IndustrialStudyRecord } from "@bim-studio/contracts";
import { OperationsStudyHistory } from "./OperationsStudyHistory";
import { compareIndustrialStudies } from "./industrialStudyComparison";

describe("OperationsStudyHistory", () => {
  it("keeps history as a compact progressive-disclosure row by default", () => {
    const html = renderToStaticMarkup(<OperationsStudyHistory
      records={[study()]}
      busy={false}
      onReproduce={() => undefined}
      onOpenTarget={() => undefined}
    />);

    expect(html).toContain("operations-study-history collapsed");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("查看已保存工况输入");
  });

  it("renders a traceable reproduction and baseline comparison workflow", () => {
    const baseline = study({ id: "plant-lite:base", sourceRecordId: "base", title: "物流基线" });
    const candidate = study({
      id: "plant-lite:next",
      sourceRecordId: "next",
      title: "物流复现",
      fingerprints: { ...baseline.fingerprints, evidence: "evidence-next" },
      lineage: { baselineStudyId: baseline.id, reproductionOf: baseline.id },
    });
    const html = renderToStaticMarkup(<OperationsStudyHistory
      records={[candidate, baseline]}
      busy={false}
      defaultExpanded
      onReproduce={() => undefined}
      onOpenTarget={() => undefined}
    />);

    expect(html).toContain("运行记录");
    expect(html).toContain("物流复现");
    expect(html).toContain("查看已保存工况输入");
    expect(html).toContain("对比基线");
    expect(html).toContain("已变化");
    expect(html).toContain("复现此工况");
  });

  it("states missing legacy evidence instead of presenting a reproducible run", () => {
    const legacy = study({
      type: "virtual-commissioning",
      scenarioInput: null,
      execution: null,
      fingerprints: { input: null, scene: null, model: null, version: null, evidence: null },
      reproduction: { kind: "open-workbench", operationsTab: "commissioning" },
    });
    const html = renderToStaticMarkup(<OperationsStudyHistory
      records={[legacy]}
      busy={false}
      defaultExpanded
      onReproduce={() => undefined}
      onOpenTarget={() => undefined}
    />);

    expect(html).toContain("旧记录缺少执行引擎证据");
    expect(html).toContain("旧记录缺少完整工况输入，不能宣称精确复现");
    expect(html).toContain("打开并复核");
  });

  it("compares every fingerprint with explicit missing semantics", () => {
    const baseline = study();
    const candidate = study({
      fingerprints: { ...baseline.fingerprints, scene: "scene-next", model: null },
    });
    expect(compareIndustrialStudies(candidate, baseline)).toEqual([
      { key: "input", label: "工况输入", status: "same" },
      { key: "scene", label: "场景", status: "changed" },
      { key: "model", label: "模型", status: "missing" },
      { key: "version", label: "引擎版本", status: "same" },
      { key: "evidence", label: "结果证据", status: "same" },
    ]);
  });
});

function study(overrides: Partial<IndustrialStudyRecord> = {}): IndustrialStudyRecord {
  return {
    id: "plant-lite:study-1",
    sourceRecordId: "study-1",
    projectId: "project-1",
    type: "plant-lite",
    title: "物流运行",
    scenarioInput: { seed: "fixed" },
    context: { sceneId: null, objectIds: [], modelId: null, modelVersion: null },
    fingerprints: {
      input: "input-1",
      scene: "scene-1",
      model: "model-1",
      version: "version-1",
      evidence: "evidence-1",
    },
    execution: { engineId: "plant-lite-des", engineVersion: "1.0.0", deterministic: true },
    run: { status: "completed", cancellable: false },
    result: {
      headline: "完成 12 次有效重复",
      metrics: [{ key: "throughput", label: "平均产出", value: 60, unit: "/h" }],
      evidenceRefs: ["evidence-1"],
      completedAt: "2026-08-31T08:00:00.000Z",
    },
    lineage: { baselineStudyId: null, reproductionOf: null },
    reproduction: { kind: "rerun", operationsTab: "logistics" },
    createdAt: "2026-08-31T08:00:00.000Z",
    updatedAt: "2026-08-31T08:00:00.000Z",
    ...overrides,
  };
}
