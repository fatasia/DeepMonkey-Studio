import { describe, expect, it } from "vitest";
import { normalizeCoverTheme } from "./dashboardTemplateCoverRuntime";

/**
 * 封面管线主题键归一(u131 取证补充的纯逻辑):
 * 缓存键与主题观察共用同一口径——仅字面 "light" 为 light,其余全按 dark,
 * 保证"同运行时同主题"判定不会因 undefined/异常值产生第三种键。
 */
describe("normalizeCoverTheme", () => {
  const cases: Array<[string | undefined, "light" | "dark"]> = [
    ["light", "light"],
    ["dark", "dark"],
    [undefined, "dark"],
    ["", "dark"],
    ["LIGHT", "dark"],
    ["system", "dark"],
  ];
  it.each(cases)("%s → %s", (input, expected) => {
    expect(normalizeCoverTheme(input)).toBe(expected);
  });
});
