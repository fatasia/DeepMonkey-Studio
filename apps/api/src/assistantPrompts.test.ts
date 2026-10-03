import { describe, expect, it } from "vitest";
import { assistantPrompts } from "./system.js";

describe("platform assistant prompts", () => {
  it("compresses oversized context into valid JSON instead of cutting it mid-structure", () => {
    const context = { records: "数".repeat(80_000), laterSource: "kept" };
    const result = assistantPrompts("platform", "分析", context);
    expect(result.contextWarning).toContain("24000 字符预算压缩");
    expect(result.userPrompt.length).toBeLessThan(24_000);
    const sent = JSON.parse(result.sentContext) as { records: string; laterSource: string; contextBudget: { trimmed: Array<{ id: string }> } };
    expect(sent.records).toContain("已截断，原80000字符");
    expect(sent.laterSource).toBe("kept");
    expect(sent.contextBudget.trimmed.map((item) => item.id)).toEqual(["records"]);
    expect(result.userPrompt.endsWith("用户问题：分析")).toBe(true);
  });

  it("falls back to an honest prefix cut only when the budgeter cannot shrink the context", () => {
    const stubborn = Object.fromEntries(Array.from({ length: 3_000 }, (_, i) => [`k${i}`, i]));
    const result = assistantPrompts("scene", "分析", stubborn, { budgetChars: 8_000 });
    expect(result.contextWarning).toContain("上下文已截断");
    expect(result.userPrompt).toContain("不是完整 JSON");
    expect(result.contextSentChars).toBeLessThan(JSON.stringify(stubborn).length);
  });

  it("does not split a surrogate pair at the fallback prefix boundary", () => {
    const limit = 8_000 - assistantPrompts("scene", "分析", {}).systemPrompt.length - 2 - 240;
    const stubborn = { [`${"k".repeat(limit - 3)}😀😀`]: 1 };
    const result = assistantPrompts("scene", "分析", stubborn, { budgetChars: 8_000 });
    expect(result.contextWarning).toContain(`仅前 ${limit - 1} 个发送给模型`);
    expect(/[\uD800-\uDBFF]$/.test(result.sentContext)).toBe(false);
  });
  it("preserves complete context without a truncation warning and puts the question last", () => {
    const result = assistantPrompts("scene", "分析", { selected: "设备一" });
    expect(result.contextWarning).toBeUndefined();
    expect(result.userPrompt).toBe('当前上下文：{"selected":"设备一"}\n\n用户问题：分析');
  });

  it("keeps the prompt prefix byte-stable across questions so provider prefix caches can hit", () => {
    const context = { availableCapabilities: [{ id: "a.b", label: "能力", kind: "analysis", inputSchemaVersion: "1", inputSchema: { type: "object" } }], aiProvider: { id: "p" }, platform: { operations: { models: [1, 2, 3] } }, workspace: { selected: { id: "m1" } } };
    const one = assistantPrompts("platform", "第一个问题", context);
    const two = assistantPrompts("platform", "完全不同的第二个问题，更长一些", context);
    const common = one.userPrompt.slice(0, one.userPrompt.indexOf("用户问题："));
    expect(two.userPrompt.startsWith(common)).toBe(true);
    expect(one.systemPrompt).toBe(two.systemPrompt);
    expect(common.indexOf("availableCapabilities")).toBeLessThan(common.indexOf("platform"));
    expect(common.indexOf("platform")).toBeLessThan(common.indexOf("workspace"));
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
