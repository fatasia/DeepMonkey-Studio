import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("dashboard canvas typography boundary", () => {
  it("keeps workspace readability rules out of authored canvas font and control dimensions", async () => {
    const css = await readFile(new URL("accessibilityReadability.css", import.meta.url), "utf8");
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
    const shellRules = rules.filter(([, selector, body]) => selector!.includes("body .app-workspace-frame.app-workspace-frame") && (body!.includes("font-size: 12px !important") || body!.includes("min-height: 28px")));
    expect(shellRules).toHaveLength(3);
    for (const [rule] of shellRules) expect(rule).toContain(":not(:where(.dashboard-artboard *))");
    // 只隔离作品内容，工作台壳层仍保留字号和点击目标下限。
    expect(shellRules[0]![2]).toContain("font-size: 12px !important");
    expect(shellRules[1]![2]).toContain("min-width: 28px");
  });
});
