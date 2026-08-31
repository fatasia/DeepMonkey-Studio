import { describe, expect, it } from "vitest";
import { DASHBOARD_COMPONENT_BACKGROUNDS } from "./DashboardComponentBackgroundCatalog";

describe("DashboardComponentBackgroundCatalog", () => {
  it("provides a diverse, self-contained component background library", () => {
    expect(DASHBOARD_COMPONENT_BACKGROUNDS.length).toBeGreaterThanOrEqual(16);
    expect(new Set(DASHBOARD_COMPONENT_BACKGROUNDS.map((asset) => asset.id)).size).toBe(DASHBOARD_COMPONENT_BACKGROUNDS.length);
    expect(new Set(DASHBOARD_COMPONENT_BACKGROUNDS.map((asset) => asset.category))).toEqual(new Set(["business", "industrial", "technology", "light"]));
    expect(DASHBOARD_COMPONENT_BACKGROUNDS.every((asset) => asset.url.startsWith("data:image/svg+xml,"))).toBe(true);
  });
});
