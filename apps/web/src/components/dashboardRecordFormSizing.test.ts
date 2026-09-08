import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dashboardRecordFormSizing } from "./dashboardRecordFormSizing";

describe("record form readable sizing", () => {
  it.each([[1, 1], [.765625, .765625], [.4, .4], [.8, .6], [2, 2]])("keeps 13px text and 32px controls without changing geometry at %s/%s", (x, y) => {
    const style = dashboardRecordFormSizing(x, y) as Record<string, string>;
    expect(parseFloat(style["--dashboard-form-font-size"]!) * y).toBeGreaterThanOrEqual(13);
    expect(parseFloat(style["--dashboard-form-control-height"]!) * y).toBeGreaterThanOrEqual(32 - 1e-9);
    expect(Object.keys(style)).toEqual(["--dashboard-form-font-size", "--dashboard-form-control-height"]);
  });
  it("handles unavailable viewport measurements without invalid styles", () => {
    expect(dashboardRecordFormSizing(0, NaN)).toEqual(dashboardRecordFormSizing(1, 1));
    expect(dashboardRecordFormSizing(-1, Infinity)).toEqual(dashboardRecordFormSizing(1, 1));
  });
  it("uses existing theme tokens for resource search, added state, and delete controls", async () => {
    const library = await readFile(new URL("../styles/dashboardComponentLibrary.css", import.meta.url), "utf8");
    const workspace = await readFile(new URL("../styles/dashboard-workspace.css", import.meta.url), "utf8");
    for (const [css, selector] of [[library, ".dashboard-library-search"], [library, ".dashboard-library-card.added"], [workspace, ".dashboard-delete-node"]] as const) {
      const block = css.slice(css.indexOf(`${selector} {`)).split("}")[0];
      expect(block).toContain("var(--"); expect(block).not.toMatch(/#[\da-f]{3,8}|rgba?\(/i);
    }
    const form = await readFile(new URL("./DashboardRecordForm.css", import.meta.url), "utf8");
    expect(form).toContain("overflow: auto"); expect(form).not.toContain("transform:");
  });
});
