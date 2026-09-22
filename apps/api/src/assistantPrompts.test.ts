import { describe, expect, it } from "vitest";
import { assistantPrompts } from "./system.js";

describe("platform assistant prompts", () => {
  it("identifies the actual context prefix sent and excludes later sources", () => {
    const context = { records: "数".repeat(80_000), laterSource: "not-sent" };
    const result = assistantPrompts("platform", "分析", context);
    expect(result.contextWarning).toContain(`${JSON.stringify(context).length} 个 UTF-16 字符`);
    expect(result.contextWarning).toContain("仅前 80000 个发送给模型");
    expect(result.userPrompt).toContain(result.contextWarning!);
    expect(result.userPrompt).toContain("不是完整 JSON");
    expect(result.userPrompt.endsWith(JSON.stringify(context).slice(0, 80_000))).toBe(true);
    expect(result.userPrompt).not.toContain("not-sent");
  });

  it("does not split a surrogate pair at the prefix boundary", () => {
    const result = assistantPrompts("scene", "分析", { text: "x".repeat(79_990) + "😀尾部" });
    expect(result.contextWarning).toContain("仅前 79999 个发送给模型");
    expect(result.userPrompt.endsWith("x")).toBe(true);
  });

  it("preserves complete context without a truncation warning", () => {
    const result = assistantPrompts("scene", "分析", { selected: "设备一" });
    expect(result.contextWarning).toBeUndefined();
    expect(result.userPrompt).toBe('分析\n\n当前上下文：{"selected":"设备一"}');
  });
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
