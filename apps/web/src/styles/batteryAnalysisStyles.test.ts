import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const stylesheet = new URL("./battery-analysis.css", import.meta.url);

describe("battery analysis visual contracts", () => {
  it("derives battery colors from the shared theme and brand tokens", async () => {
    const css = await readFile(stylesheet, "utf8");
    expect(css).toContain("var(--accent)");
    expect(css).toContain("var(--surface-1)");
    expect(css).toContain("var(--text-strong)");
    expect(css).not.toMatch(/#[\da-f]{3,8}|rgba?\(/i);
  });

  it("collapses analysis controls and evidence grids at the phone breakpoint", async () => {
    const css = await readFile(stylesheet, "utf8");
    expect(css).toMatch(/@media \(max-width:680px\)[\s\S]*?\.battery-task-picker \{ grid-template-columns:1fr; \}/);
    expect(css).toMatch(/@media \(max-width:680px\)[\s\S]*?\.battery-report-boundary,\.battery-report-physics \{ grid-template-columns:repeat\(2,minmax\(0,1fr\)\); \}/);
  });
});
