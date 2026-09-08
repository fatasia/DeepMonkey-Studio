import { describe, expect, it } from "vitest";
import { assistantPrompts, parseAssistantContent } from "./assistantPrompts.js";
describe("2D dashboard prompt compatibility", () => {
  it("uses the page patch contract only for an explicitly identified 2D request", () => {
    expect(assistantPrompts("dashboard", "生成", { workspace: { dashboardDraftVersion: 1 } }).systemPrompt).toContain("dashboardPageDraft");
    expect(assistantPrompts("dashboard", "生成", { workspace: { dashboardDraftVersion: 2 } }).systemPrompt).toContain("x,y,w,h,color");
    expect(assistantPrompts("dashboard", "生成", {}).systemPrompt).toContain("x,y,w,h,color");
  });
  it("returns the untrusted page draft for client validation and retains legacy 3D responses", () => {
    const raw = { version: 99, changes: [] };
    expect(parseAssistantContent("dashboard", JSON.stringify({ text: "草案", dashboardPageDraft: raw }), "fixture").dashboardPageDraft).toEqual(raw);
    expect(parseAssistantContent("dashboard", '{"text":"旧方案","dashboard":{"widgets":[]}}', "fixture").dashboard).toEqual({ widgets: [] });
  });
});
