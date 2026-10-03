import { describe, expect, it } from "vitest";
import { autoRoutingAvailable, resolveAiRoutingConfig, routeAssistantModel, routeReceipt, type AiRoutingConfig } from "./assistantModelRouter.js";

const routing: AiRoutingConfig = { fastModel: "mini", fastMaxQuestionChars: 160, strongKeywords: [] };
const settings = { model: "frontier", reasoningEffort: "deep" as const, routing };
const route = (question: string, overrides: Partial<Parameters<typeof routeAssistantModel>[0]> = {}) =>
  routeAssistantModel({ mode: "platform", question, settings, auto: true, assessment: "allow", ...overrides });

describe("assistant model router", () => {
  it.each([
    "当前有哪些告警？", "AGV-17 状态怎么样", "现在有几台设备在线", "最新的模型版本是什么", "列出所有数据集", "What is the current status of line 2?", "how many models are installed",
  ])("sends simple read-only questions to the fast model: %s", (question) => {
    expect(route(question)).toEqual({ tier: "fast", model: "mini", reason: "simple-question" });
  });

  it.each([
    "把 AGV-17 移动到 3 号工位", "帮我创建一个新看板", "删除这个场景里的灯光", "修改设备温度阈值", "导出当前报告", "请把状态设置为停止",
    "Delete the selected model", "please update the dashboard", "run the simulation now", "enable the alarm rule",
  ])("never routes write or control intent to the fast model: %s", (question) => {
    expect(route(question)).toMatchObject({ tier: "strong", model: "frontier", reason: "write-intent" });
  });

  it.each([
    ["为什么 3 号线节拍下降", "planning-or-code"], ["帮我分析根因并给出优化方案", "planning-or-code"], ["写一个函数计算 OEE", "planning-or-code"],
    ["对比两个模型的差异", "planning-or-code"], ["how should we design the alarm flow", "planning-or-code"], ["先看当前状态，然后给出结论", "multi-step"],
    ["status ```ts\nconst a = 1\n```", "code-input"],
  ])("keeps planning, coding and multi-step requests on the strong model: %s", (question, reason) => {
    expect(route(question)).toMatchObject({ tier: "strong", model: "frontier", reason });
  });

  it("fails open to the default model for unmatched, long, risky or unsupported-mode requests", () => {
    expect(route("嗯")).toMatchObject({ tier: "strong", reason: "no-fast-match" });
    expect(route(`当前状态${"补充说明".repeat(60)}`)).toMatchObject({ tier: "strong", reason: "long-question" });
    expect(route("当前有哪些告警？", { assessment: "constrain" })).toMatchObject({ tier: "strong", reason: "input-risk" });
    expect(route("当前有哪些告警？", { assessment: "block" })).toMatchObject({ tier: "strong", reason: "input-risk" });
    for (const mode of ["bim", "dashboard", "sql"]) expect(route("当前有哪些告警？", { mode })).toMatchObject({ tier: "strong", reason: "mode-needs-strong" });
  });

  it("is a no-op unless the user chose auto and a distinct fast model is configured", () => {
    expect(route("当前有哪些告警？", { auto: false })).toMatchObject({ tier: "strong", model: "frontier", reason: "not-auto" });
    expect(route("当前有哪些告警？", { settings: { model: "frontier" } })).toMatchObject({ model: "frontier", reason: "no-fast-model" });
    expect(route("当前有哪些告警？", { settings: { model: "mini", routing } })).toMatchObject({ model: "mini", reason: "no-fast-model" });
  });

  it("keeps the default model's reasoning effort on strong routes and never carries it to the fast model", () => {
    expect(route("为什么节拍下降")).toMatchObject({ tier: "strong", reasoningEffort: "deep" });
    expect(route("当前有哪些告警？")).not.toHaveProperty("reasoningEffort");
  });

  it("honors extra strong keywords and returns the strong model if the router itself throws", () => {
    const custom = { ...settings, routing: { ...routing, strongKeywords: ["合规"] } };
    expect(route("当前合规状态", { settings: custom })).toMatchObject({ tier: "strong", reason: "custom-keyword" });
    const broken = { ...settings, routing: { get fastModel(): string { throw new Error("boom"); } } as unknown as AiRoutingConfig };
    expect(route("当前有哪些告警？", { settings: broken })).toMatchObject({ tier: "strong", model: "frontier", reason: "router-error" });
  });

  it("builds a receipt and resolves configuration from the environment", () => {
    expect(routeReceipt({ tier: "fast", model: "mini", reason: "simple-question" })).toEqual({ mode: "auto", tier: "fast", model: "mini", reason: "simple-question" });
    expect(routeReceipt({ tier: "strong", model: "frontier", reason: "write-intent" }, true)).toMatchObject({ fellBack: true });
    expect(resolveAiRoutingConfig({})).toEqual({ fastMaxQuestionChars: 160, strongKeywords: [] });
    expect(resolveAiRoutingConfig({ AI_ROUTER_FAST_MODEL: " mini ", AI_ROUTER_FAST_MAX_CHARS: "300", AI_ROUTER_STRONG_KEYWORDS: "合规, SQL ," }))
      .toEqual({ fastModel: "mini", fastMaxQuestionChars: 300, strongKeywords: ["合规", "sql"] });
    expect(resolveAiRoutingConfig({ AI_ROUTER_FAST_MODEL: "mini", AI_ROUTER_ENABLED: "off" })).not.toHaveProperty("fastModel");
    expect(resolveAiRoutingConfig({ AI_ROUTER_FAST_MAX_CHARS: "5" }).fastMaxQuestionChars).toBe(160);
  });

  it("advertises auto only for a configured, distinct and (when known) listed fast model", () => {
    expect(autoRoutingAvailable({ model: "frontier", routing })).toBe(true);
    expect(autoRoutingAvailable({ model: "frontier", routing }, ["frontier", "mini"])).toBe(true);
    expect(autoRoutingAvailable({ model: "frontier", routing }, ["frontier"])).toBe(false);
    expect(autoRoutingAvailable({ model: "mini", routing })).toBe(false);
    expect(autoRoutingAvailable({ model: "frontier" })).toBe(false);
  });
});
