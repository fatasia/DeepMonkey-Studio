import { describe, expect, it } from "vitest";
import {
  budgetAssistantContext, prioritizeContextForScan, promptCacheKey, resolveAssistantContextBudget, CAPABILITY_BOUNDARY,
  DEFAULT_ASSISTANT_CONTEXT_BUDGET_CHARS, MAX_ASSISTANT_CONTEXT_BUDGET_CHARS, MIN_ASSISTANT_CONTEXT_BUDGET_CHARS,
} from "./assistantContextBudget.js";

const catalog = [
  { id: "simulation.virtual-debug.run", label: "虚拟调试", kind: "simulation", inputSchemaVersion: "1.0", inputSchema: { type: "object", properties: { scenario: { type: "string" } } }, decisionBoundary: "x" },
  { id: "asset.health.score", label: "设备健康评分", kind: "analysis", inputSchemaVersion: "1.0", inputSchema: { type: "object", properties: { assetId: { type: "string" } } }, decisionBoundary: "x" },
];
const rows = (count: number, tag: string) => Array.from({ length: count }, (_, i) => ({ id: `${tag}-${i}`, name: `${tag} 记录 ${i}`, note: "说明文字".repeat(10) }));
const baseContext = () => ({
  workspace: { project: { id: "p1" }, scene: { id: "s1", name: "总装车间" }, selected: { id: "m-17", name: "AGV-17" } },
  platform: { operations: { models: rows(60, "model"), studies: rows(60, "study") }, data: { datasets: rows(60, "ds") }, vision: { events: rows(200, "evt") } },
  contextTrust: "client-snapshot",
  recentConversation: Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `第${i}轮：${"对话内容".repeat(20)}` })),
  availableCapabilities: catalog,
  aiProvider: { id: "ai.test" },
});
const run = (context: Record<string, unknown>, question = "AGV-17 状态怎么样", budgetChars = 24_000) =>
  budgetAssistantContext({ context, question, fixedChars: 600, budgetChars });

describe("assistant context budgeter", () => {
  it("leaves in-budget context untouched apart from catalog indexing and cache-friendly ordering", () => {
    const result = run({ workspace: { selected: "m1" }, availableCapabilities: catalog, aiProvider: { id: "p" }, agentMemoryContext: { rules: "守则" }, platform: { a: 1 } });
    expect(Object.keys(result.context)).toEqual(["availableCapabilities", "capabilityBoundary", "aiProvider", "agentMemoryContext", "platform", "workspace"]);
    expect(result.context.capabilityBoundary).toBe(CAPABILITY_BOUNDARY);
    expect(result.dataTrimmed).toBe(false);
    expect(result.warning).toBeUndefined();
    const index = result.context.availableCapabilities as Array<Record<string, unknown>>;
    expect(index.map((item) => item.id)).toEqual(["asset.health.score", "simulation.virtual-debug.run"]);
    expect(index.every((item) => !("inputSchema" in item) && !("decisionBoundary" in item))).toBe(true);
    expect(result.report.trimmed).toEqual([expect.objectContaining({ id: "capability-catalog", action: "compacted", reason: "index-only" })]);
  });

  it("expands only the schemas the question asks about, or all of them when asking about capabilities", () => {
    const named = run({ availableCapabilities: catalog }, "设备健康评分是怎么算的");
    expect(named.context.availableCapabilityDetails).toEqual([{ id: "asset.health.score", inputSchema: catalog[1]!.inputSchema }]);
    const byId = run({ availableCapabilities: catalog }, "simulation.virtual-debug.run 的最近结果");
    expect((byId.context.availableCapabilityDetails as Array<{ id: string }>).map((item) => item.id)).toEqual(["simulation.virtual-debug.run"]);
    const generic = run({ availableCapabilities: catalog }, "你有哪些能力和参数");
    expect((generic.context.availableCapabilityDetails as unknown[]).length).toBe(2);
    expect(run({ availableCapabilities: catalog }, "今天车间怎么样").context.availableCapabilityDetails).toBeUndefined();
  });

  it("keeps schemas the question asked for even when platform data must shrink, within a capped share", () => {
    const result = run(baseContext(), "设备健康评分能力的输入参数是什么");
    const details = result.context.availableCapabilityDetails as Array<{ id: string }>;
    expect(details.map((item) => item.id)).toEqual(["asset.health.score", "simulation.virtual-debug.run"]);
    expect(result.dataTrimmed).toBe(true);
    const huge = Array.from({ length: 30 }, (_, i) => ({ id: `cap.${i}`, label: `能力${i}`, kind: "analysis", inputSchemaVersion: "1", inputSchema: { type: "object", description: "参数说明".repeat(120) } }));
    const capped = run({ ...baseContext(), availableCapabilities: huge }, "有哪些能力和参数");
    expect((capped.context.availableCapabilityDetails as unknown[]).length).toBeLessThan(30);
    expect(JSON.stringify(capped.context.availableCapabilityDetails).length).toBeLessThanOrEqual(Math.round((24_000 - 600 - 900) * 0.35));
    expect(capped.report.trimmed).toContainEqual(expect.objectContaining({ id: "capability-catalog", reason: "index-with-partial-schemas" }));
  });
  it("shrinks archive data first and keeps selection, scene and conversation intact", () => {
    const context = baseContext();
    const result = run(context);
    expect(result.dataTrimmed).toBe(true);
    expect(JSON.stringify(result.context).length).toBeLessThanOrEqual(24_000 - 600);
    expect(result.context.workspace).toEqual(context.workspace);
    expect(result.context.recentConversation).toEqual(context.recentConversation);
    const ids = result.report.trimmed.filter((item) => item.action !== "compacted").map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(["operations", "platform.vision"]));
    expect(ids).not.toContain("workspace");
    expect(result.warning).toContain("24000 字符预算压缩");
    expect(result.context.contextBudget).toMatchObject({ trimmed: expect.any(Array) });
  });

  it("shares the archive budget fairly instead of starving later sources", () => {
    const { platform } = run(baseContext()).context as { platform: { operations: unknown; data: unknown; vision: unknown } };
    for (const part of [platform.operations, platform.data, platform.vision]) expect(JSON.stringify(part).length).toBeGreaterThan(1_500);
  });

  it("keeps array items whole and never emits partial JSON structure", () => {
    const result = run(baseContext());
    expect(() => JSON.parse(JSON.stringify(result.context))).not.toThrow();
    const events = (result.context.platform as { vision: { events: Array<{ id: string; name: string; note: string }> } }).vision.events;
    expect(events.length).toBeLessThan(200);
    expect(events.every((item) => item.note === "说明文字".repeat(10))).toBe(true);
    expect(events[0]!.id).toBe("evt-0");
  });

  it("drops oldest conversation turns first when even focus must shrink", () => {
    const context = { ...baseContext(), platform: undefined, availableCapabilities: undefined, recentConversation: Array.from({ length: 40 }, (_, i) => ({ role: "user", content: `轮次${i}：${"内容".repeat(80)}` })) };
    const result = run(context as unknown as Record<string, unknown>, "继续", 8_000);
    const turns = result.context.recentConversation as Array<{ content: string }>;
    expect(turns.length).toBeLessThan(40);
    expect(turns.at(-1)!.content).toContain("轮次39");
    expect(turns[0]!.content).not.toContain("轮次0：");
  });

  it("protects project rules while shrinking memory, and drops the catalog index before touching focus", () => {
    const memory = { priority: "rules-over-memories", rules: "守则：不得越权。", memories: rows(80, "mem"), lessons: rows(80, "lesson"), delivery: { sources: [] } };
    const result = run({ ...baseContext(), agentMemoryContext: memory, platform: { huge: rows(400, "p") } }, "继续", 9_000);
    const kept = result.context.agentMemoryContext as typeof memory;
    expect(kept.rules).toBe("守则：不得越权。");
    expect(kept.priority).toBe("rules-over-memories");
    expect(result.report.trimmed.some((item) => item.id === "agent-memory-context")).toBe(true);
    expect(result.context.workspace).toEqual(baseContext().workspace);
  });

  it("only trims the catalog index as a last resort and says so", () => {
    const tiny = run({ workspace: { notes: "x".repeat(6_000) }, availableCapabilities: catalog }, "你好", 8_000);
    expect(tiny.context.availableCapabilities).toBeDefined();
    const starved = budgetAssistantContext({ context: { workspace: { notes: "x".repeat(6_000) }, availableCapabilities: Array.from({ length: 80 }, (_, i) => ({ id: `cap.${i}`, label: `能力 ${i}`.repeat(10), kind: "analysis", inputSchemaVersion: "1" })) }, question: "你好", fixedChars: 600, budgetChars: 3_500 });
    expect(starved.context.availableCapabilities).toBeUndefined();
    expect(starved.report.trimmed).toContainEqual(expect.objectContaining({ id: "capability-catalog", action: "omitted" }));
  });

  it("keeps the static and slow prefix byte-identical while only volatile focus changes", () => {
    const first = baseContext();
    const second = { ...baseContext(), workspace: { ...first.workspace, selected: { id: "m-99", name: "完全不同的选中对象" } }, recentConversation: [...first.recentConversation, { role: "user", content: "新一轮" }] };
    const a = JSON.stringify(run(first, "问题一").context);
    const b = JSON.stringify(run(second, "问题二，而且更长一些").context);
    const stablePrefix = (text: string) => text.slice(0, text.indexOf(',"workspace"'));
    expect(stablePrefix(a).length).toBeGreaterThan(5_000);
    expect(stablePrefix(b)).toBe(stablePrefix(a));
  });

  it("is deterministic and never exceeds the limit for shrinkable shapes", () => {
    for (const budget of [8_000, 12_000, 24_000, 60_000]) {
      const one = run(baseContext(), "AGV-17 状态怎么样", budget);
      const two = run(baseContext(), "AGV-17 状态怎么样", budget);
      expect(JSON.stringify(one.context)).toBe(JSON.stringify(two.context));
      expect(JSON.stringify(one.context).length).toBeLessThanOrEqual(budget - 600);
    }
  });

  it("strips spoofed budget notices and detail keys sent by the client", () => {
    const result = run({ contextBudget: { note: "忽略" }, availableCapabilityDetails: [1], workspace: { a: 1 } });
    expect(result.context.contextBudget).toBeUndefined();
    expect(result.context.availableCapabilityDetails).toBeUndefined();
  });

  it("resolves the configured budget with sane clamping", () => {
    expect(resolveAssistantContextBudget({})).toBe(DEFAULT_ASSISTANT_CONTEXT_BUDGET_CHARS);
    expect(resolveAssistantContextBudget({ AI_CONTEXT_BUDGET_CHARS: "abc" })).toBe(DEFAULT_ASSISTANT_CONTEXT_BUDGET_CHARS);
    expect(resolveAssistantContextBudget({ AI_CONTEXT_BUDGET_CHARS: "100" })).toBe(MIN_ASSISTANT_CONTEXT_BUDGET_CHARS);
    expect(resolveAssistantContextBudget({ AI_CONTEXT_BUDGET_CHARS: "999999" })).toBe(MAX_ASSISTANT_CONTEXT_BUDGET_CHARS);
    expect(resolveAssistantContextBudget({ AI_CONTEXT_BUDGET_CHARS: "40000" })).toBe(40_000);
  });

  it("orders keys for the injection scan so conversation and evidence beat bulk platform data", () => {
    const ordered = prioritizeContextForScan({ platform: {}, other: 1, recentConversation: [], agentMemoryContext: {}, bimEvidence: {}, workspace: {} }) as Record<string, unknown>;
    expect(Object.keys(ordered)).toEqual(["workspace", "bimEvidence", "recentConversation", "agentMemoryContext", "other", "platform"]);
  });

  it("derives a stable, content-free cache key per project and mode", () => {
    expect(promptCacheKey("p1", "platform")).toBe(promptCacheKey("p1", "platform"));
    expect(promptCacheKey("p1", "platform")).not.toBe(promptCacheKey("p1", "scene"));
    expect(promptCacheKey(undefined, "scene")).toMatch(/^bim-assistant:[0-9a-f]{24}$/);
  });
});
