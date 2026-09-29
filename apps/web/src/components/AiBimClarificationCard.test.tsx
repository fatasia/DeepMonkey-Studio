import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BimAssistantPreparedContext } from "../bimAssistant";
import { AiBimClarificationCard } from "./AiBimClarificationCard";

function evidence(overrides: Partial<BimAssistantPreparedContext> = {}): BimAssistantPreparedContext {
  return {
    schema: "bim-studio/bim-assistant-context@1",
    question: "车间里有多少摄像头？",
    intents: ["count"],
    confidence: "insufficient",
    scene: { modelCount: 1, componentCount: 120, spaceCount: 8, levels: ["F1"], levelCounts: [{ name: "F1", count: 120 }], categories: [], systems: [] },
    query: { aliases: ["摄像头"] },
    matchCount: 0,
    matches: [],
    limitations: [],
    ...overrides,
  };
}

/** T3（审计 §二 2.1）：bim 低置信匹配不再"不问就答"——就地给候选确认卡。 */
describe("AiBimClarificationCard（T3 低置信澄清卡）", () => {
  it("insufficient + 有候选：列出候选名并可点定位，说明来自关键词匹配", () => {
    const item = { id: "c1", stableId: "s-c1", modelId: "m1", modelName: "厂房", name: "摄像头-01", type: "Camera", properties: {} };
    const html = renderToStaticMarkup(
      <AiBimClarificationCard locale="zh-CN"
        evidence={evidence({ matchCount: 2, matches: [item, { ...item, id: "c2", stableId: "s-c2", name: "摄像头-02" }] })}
        onAction={vi.fn()} />,
    );
    expect(html).toContain("未找到明确匹配的构件");
    expect(html).toContain("2 个候选");
    expect(html).toContain("摄像头-01");
    expect(html).toContain("摄像头-02");
    expect(html).toContain("点选可定位确认");
    expect(html).not.toContain("disabled");
  });

  it("insufficient + 零候选：如实说明并引导补名称/楼层/类别，不伪造匹配", () => {
    const html = renderToStaticMarkup(
      <AiBimClarificationCard locale="zh-CN" evidence={evidence({ matchCount: 0, matches: [] })} onAction={vi.fn()} />,
    );
    expect(html).toContain("本次没有匹配到构件");
    expect(html).toContain("补充构件名称、所在楼层或系统类别");
    expect(html).not.toContain("ai-clarification-options");
  });

  it("exact / inferred 置信度渲染 null（走既有 BimAssistantEvidence 快照卡）", () => {
    const exact = renderToStaticMarkup(
      <AiBimClarificationCard locale="zh-CN" evidence={evidence({ confidence: "exact", matchCount: 3 })} onAction={vi.fn()} />,
    );
    const inferred = renderToStaticMarkup(
      <AiBimClarificationCard locale="zh-CN" evidence={evidence({ confidence: "inferred", matchCount: 3 })} onAction={vi.fn()} />,
    );
    expect(exact).toBe("");
    expect(inferred).toBe("");
  });

  it("缺省 onAction 时候选禁用（无三维场景动作位仍可读）", () => {
    const item = { id: "c1", stableId: "s-c1", modelId: "m1", modelName: "厂房", name: "摄像头-01", type: "Camera", properties: {} };
    const html = renderToStaticMarkup(
      <AiBimClarificationCard locale="zh-CN" evidence={evidence({ matchCount: 1, matches: [item] })} />,
    );
    expect(html).toContain("摄像头-01");
    expect(html).toContain("disabled");
  });
});
