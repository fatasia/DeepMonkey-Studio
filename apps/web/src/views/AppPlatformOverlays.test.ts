import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("platform assistant workspace routing", () => {
  it("routes the 2D editor into the shared assistant without duplicating the floating utility", async () => {
    const source = await readFile(new URL("./AppPlatformOverlays.tsx", import.meta.url), "utf8");
    expect(source).toContain('"manager", "dashboard", "optimizer"');
    expect(source).toContain('currentView: "dashboard"');
    expect(source).toContain("onValidateDashboardPageDraft");
    expect(source).toContain("onApplyDashboardPageDraft");
    expect(source).toContain('const utilityViews = new Set(["manager", "optimizer"');
  });
});
