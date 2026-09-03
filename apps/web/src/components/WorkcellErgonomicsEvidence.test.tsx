import type { WorkcellErgonomicsCheck } from "@bim-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkcellErgonomicsEvidence } from "./WorkcellErgonomicsEvidence";

describe("WorkcellErgonomicsEvidence", () => {
  it("renders measured rules, missing evidence and the planning-only boundary", () => {
    const complete: WorkcellErgonomicsCheck = {
      profileId: "task-1", profileName: "装配人员 · 人工作业", operatorObjectId: "person-1", workPointObjectId: "station-1",
      status: "warn", missingFields: [], evidenceCoverage: 1, anthropometrySource: "reference-table", anthropometryReference: "企业人体数据表 v2",
      taskSource: "author-confirmed", policySource: "author-confirmed", recommendations: ["把物料移入近身工作区。"],
      rules: [{ id: "forward-reach", label: "水平前伸", status: "warn", measuredValue: .6, limitValue: .7, utilization: .6 / .7, unit: "m", detail: "前伸接近限值。", recommendation: "把物料移入近身工作区。" }],
      declaration: "仅做规划初筛，不输出 NIOSH、RULA 或认证结论。",
    };
    const missing: WorkcellErgonomicsCheck = {
      profileId: "task-2", profileName: "上料人员 · 人工作业", status: "needs-data", missingFields: ["stature", "work-point", "load-mass"],
      rules: [{ id: "manual-load", label: "单次搬运负荷", status: "needs-data", detail: "待补充", recommendation: "补充负荷。" }],
      evidenceCoverage: .2, recommendations: ["补齐证据。"], declaration: "缺失数据不作通过判断。",
    };
    const html = renderToStaticMarkup(<WorkcellErgonomicsEvidence checks={[complete, missing]} />);

    expect(html).toContain("人工作业规划筛查");
    expect(html).toContain("0.6 m / 限值 0.7 m");
    expect(html).toContain("企业人体数据表 v2");
    expect(html).toContain("身高、作业点、单次负荷");
    expect(html).toContain("不输出 NIOSH");
    expect(html).not.toContain("0 kg");
  });
});
