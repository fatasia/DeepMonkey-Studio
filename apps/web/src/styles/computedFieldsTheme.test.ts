import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("computed-field theme contract", () => {
  it("uses shared theme tokens throughout headings, cards, help and errors", async () => {
    const css = await readFile(new URL("./platform-pages.css", import.meta.url), "utf8");
    const rules = css.split("\n").filter((line) => line.startsWith(".data-computed-field"));
    expect(rules.length).toBeGreaterThanOrEqual(14);
    expect(rules.join("\n")).not.toMatch(/#[\da-f]{3,8}|rgba?\(/i);
    for (const selector of [".data-computed-fields > header strong", ".data-computed-field-heading"]) {
      expect(rules.find((line) => line.startsWith(`${selector} {`))).toContain("color: var(--text-strong)");
    }
    expect(rules.find((line) => line.startsWith(".data-computed-fields article {"))).toContain("background: var(--surface-1)");
    expect(rules.find((line) => line.startsWith(".data-computed-fields article > em {"))).toContain("color: var(--danger)");
  });

  it("keeps hover scoped to enabled computed-field actions", async () => {
    const css = await readFile(new URL("./platform-pages.css", import.meta.url), "utf8");
    expect(css).toContain(".data-computed-fields > header button:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-soft); }");
    expect(css).toContain(".data-computed-field-heading button:hover:not(:disabled) { color: var(--danger); background: var(--surface-2); }");
  });
});
