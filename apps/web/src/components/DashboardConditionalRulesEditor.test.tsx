import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DashboardConditionalRule } from "@bim-studio/contracts";
import { conditionalStyle } from "./dashboardAnalytics";
import { createDashboardConditionalRule, DashboardConditionalRulesEditor, parseDashboardConditionalValue, updateDashboardConditionalRule } from "./DashboardConditionalRulesEditor";

describe("DashboardConditionalRulesEditor", () => {
  it("renders an approachable empty state and add action", () => {
    const html = renderToStaticMarkup(<DashboardConditionalRulesEditor locale="zh-CN" value={[]} onChange={() => undefined} />);
    expect(html).toContain("条件格式");
    expect(html).toContain("添加规则");
    expect(html).toContain("尚未设置规则");
  });

  it("creates collision-free rules and preserves all existing rules while editing one", () => {
    const rules: DashboardConditionalRule[] = [
      { id: "rule-2", field: "temperature", operator: "gte", value: 80, color: "#ff0000" },
      { id: "warning", field: "temperature", operator: "gte", value: 60, backgroundColor: "#442200" }
    ];
    expect(createDashboardConditionalRule(rules).id).toBe("rule-3");
    expect(updateDashboardConditionalRule(rules, "warning", { animation: "pulse", fontWeight: 700 })).toEqual([
      rules[0],
      { ...rules[1], animation: "pulse", fontWeight: 700 }
    ]);
  });

  it("feeds structured rule output into runtime conditional styling", () => {
    const configured = updateDashboardConditionalRule(
      [{ id: "hot", field: "temperature", operator: "gte", value: 80 }],
      "hot",
      { value: parseDashboardConditionalValue("85"), color: "#ff6b6b", backgroundColor: "#5b2028", fontWeight: 700, animation: "pulse" }
    );
    expect(conditionalStyle(configured, { temperature: 92 })).toEqual({ color: "#ff6b6b", backgroundColor: "#5b2028", fontWeight: 700, animation: "pulse" });
    expect(parseDashboardConditionalValue("false")).toBe(false);
    expect(conditionalStyle(configured, { temperature: 72 })).toEqual({});
  });
});
