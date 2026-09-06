import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("workspace theme boundaries", () => {
  it("keeps Vision surfaces and statuses tokenized without touching customer media", () => {
    const css = readFileSync(new URL("../styles/centers.css", import.meta.url), "utf8").split(".what-if-workspace")[0];
    expect(css).not.toMatch(/#[\da-f]{3,8}\b/i);
    expect(css).toContain("color: var(--on-accent)");
    expect(css).toContain("color: var(--danger)");
    expect(css).toContain("background: var(--surface-1)");
    expect(css).not.toMatch(/filter\s*:\s*(invert|brightness)/);
  });
  it("uses page-theme controls and brand contrast in the 2D inspector", () => {
    const css = readFileSync(new URL("../styles/dashboardWorkspacePolish.css", import.meta.url), "utf8");
    expect(css).toContain(".dashboard-inspector-panel :is(input, select, textarea)");
    expect(css).toContain("color: var(--text-strong); background: var(--surface-2); border-color: var(--line)");
    expect(css).toContain(".dashboard-canvas-toolbar button.active { color: var(--on-accent)");
  });
});
