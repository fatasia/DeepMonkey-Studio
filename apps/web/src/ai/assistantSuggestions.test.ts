import { describe, expect, it } from "vitest";
import { assistantSuggestions } from "./assistantSuggestions";

describe("assistant suggestions", () => {
  it("keeps task prompts localized and concise", () => {
    expect(assistantSuggestions("operations", "zh-CN")).toHaveLength(3);
    const english = assistantSuggestions("bim", "en-US");
    expect(english).toHaveLength(2);
    expect(english.join(" ")).toContain("levels");
    expect(english.join(" ")).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
