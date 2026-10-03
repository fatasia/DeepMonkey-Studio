import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AiContextDelivery } from "@bim-studio/contracts";
import { readContextDelivery } from "../ai/assistantContextDelivery";
import { createAiApi } from "../apiClients/aiApi";
import { AiContextDeliveryEvidence } from "./AiContextDeliveryEvidence";
import { AiExecutionDetails } from "./AiExecutionDetails";

const receipt = (budget?: AiContextDelivery["budget"]): AiContextDelivery => ({
  unit: "utf16", preparedChars: 30_000, sentChars: 18_000, ...(budget ? { budget } : {}),
  sources: [{ id: "operations", path: "platform.operations", status: "partial", preparedChars: 30_000, sentChars: 2_877, transformed: true }],
});
const budget: NonNullable<AiContextDelivery["budget"]> = {
  budgetChars: 24_000, originalChars: 109_204, usedChars: 18_017,
  trimmed: [
    { id: "capability-catalog", action: "compacted", fromChars: 24_307, toChars: 1_439, reason: "index-only" },
    { id: "operations", action: "shrunk", fromChars: 32_524, toChars: 2_877, reason: "over-budget:archive" },
    { id: "platform.vision", action: "omitted", fromChars: 16_053, toChars: 0, reason: "over-budget:archive" },
  ],
};

describe("context budget disclosure", () => {
  it("lists what was compacted, reduced or omitted with human labels and sizes", () => {
    const html = renderToStaticMarkup(<AiContextDeliveryEvidence receipt={receipt(budget)} labels={{ operations: "运营模型与评估" }} locale="zh-CN" />);
    expect(html).toContain("上下文预算 18017/24000");
    expect(html).toContain("可调用能力目录 · 压缩为索引 24307→1439");
    expect(html).toContain("运营模型与评估 · 已缩减 32524→2877");
    expect(html).toContain("视觉数据 · 已省略 16053→0");
  });

  it("stays quiet about trimming when nothing was cut, and renders without a budget at all", () => {
    expect(renderToStaticMarkup(<AiContextDeliveryEvidence receipt={receipt({ ...budget, trimmed: [] })} labels={undefined} locale="zh-CN" />)).toContain("未裁剪");
    expect(renderToStaticMarkup(<AiContextDeliveryEvidence receipt={receipt()} labels={undefined} locale="zh-CN" />)).not.toContain("上下文预算");
  });

  it("accepts a valid budget on the receipt and drops only a malformed one", () => {
    expect(readContextDelivery(receipt(budget))?.budget).toEqual(budget);
    const broken = readContextDelivery(receipt({ ...budget, trimmed: [{ id: "x", action: "explode" } as never] }));
    expect(broken).toBeDefined();
    expect(broken).not.toHaveProperty("budget");
  });
});

describe("auto routing disclosure and request", () => {
  const execution = { protocol: "responses" as const, requestedModel: "mini" };
  it("shows the actual model and reason of an automatic route, including a fail-open retry", () => {
    const fast = renderToStaticMarkup(<AiExecutionDetails locale="zh-CN" execution={{ ...execution, route: { mode: "auto", tier: "fast", model: "mini", reason: "simple-question" } }} />);
    expect(fast).toContain("自动路由");
    expect(fast).toContain("小模型");
    expect(fast).toContain("mini");
    expect(fast).toContain("简单只读问答");
    const retried = renderToStaticMarkup(<AiExecutionDetails locale="zh-CN" execution={{ ...execution, requestedModel: "frontier", route: { mode: "auto", tier: "fast", model: "mini", reason: "simple-question", fellBack: true } }} />);
    expect(retried).toContain("小模型失败，已改用强模型");
    expect(renderToStaticMarkup(<AiExecutionDetails locale="zh-CN" execution={execution} />)).not.toContain("自动路由");
  });

  it("sends routing=auto only without an explicit model", async () => {
    const stream = (text: string) => new Response(`event: done\ndata: ${JSON.stringify({ text, model: "m" })}\n\n`);
    const open = vi.fn(async () => stream("ok"));
    const api = createAiApi(vi.fn() as never, open);
    await api.streamAssistant("platform", "问题", {}, () => undefined, { routing: "auto" });
    await api.streamAssistant("platform", "问题", {}, () => undefined, { routing: "auto", model: "picked" });
    const bodies = (open.mock.calls as unknown as Array<[string, { body: string }]>).map(call => JSON.parse(call[1].body) as Record<string, unknown>);
    expect(bodies[0]).toMatchObject({ routing: "auto" });
    expect(bodies[1]).toMatchObject({ model: "picked" });
    expect(bodies[1]).not.toHaveProperty("routing");
  });
});
