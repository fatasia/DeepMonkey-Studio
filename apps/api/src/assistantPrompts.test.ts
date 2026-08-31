import { describe, expect, it } from "vitest";
import { assistantPrompts } from "./system.js";

describe("platform assistant prompts", () => {
  it("requires evidence and separates benchmark models from production", () => {
    const platform = assistantPrompts("platform", "当前有哪些模型", { platform: { operations: { models: [] } } });
    expect(platform.systemPrompt).toContain("没有证据就明确说没有");
    expect(platform.systemPrompt).toContain("公开/合成基准");
    expect(platform.userPrompt).toContain("当前有哪些模型");
  });

  it("blocks benchmark maintenance models from being described as production", () => {
    const operations = assistantPrompts("operations", "能否用于预测", {});
    expect(operations.systemPrompt).toContain("仅影子验证，不可用于生产决策");
    expect(operations.systemPrompt).toContain("不得把候选模型");
  });

  it("keeps Ask Data on a lightweight field index instead of an ontology workflow", () => {
    const askData = assistantPrompts("sql", "最近一天设备温度", { platform: { data: {} } });
    expect(askData.systemPrompt).toContain("不是本体建模工具");
    expect(askData.systemPrompt).toContain("数据集、字段、时间窗口、单位、过滤条件和证据");
    expect(askData.systemPrompt).toContain("字段未知、同名歧义或权限不明时停止");
  });
});
