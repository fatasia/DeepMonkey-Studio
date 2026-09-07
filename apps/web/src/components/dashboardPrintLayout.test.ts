import { describe, expect, it } from "vitest";
import { dashboardPrintLayout } from "./dashboardPrintLayout";

describe("dashboard paper layout", () => {
  it.each([[1920, 1080], [1080, 1920], [6000, 400], [400, 6000], [10, 10]])("fits %s × %s without stretching or clipping", (width, height) => {
    const layout = dashboardPrintLayout(width, height);
    const landscape = width >= height;
    expect(layout.orientation).toBe(landscape ? "landscape" : "portrait");
    expect(width * layout.scale).toBeLessThanOrEqual((landscape ? 281 : 194) * 96 / 25.4 + 1e-8);
    expect(height * layout.scale).toBeLessThanOrEqual((landscape ? 194 : 281) * 96 / 25.4 + 1e-8);
    expect(layout.scale).toBeGreaterThan(0);
  });
  it("keeps malformed legacy dimensions finite", () => {
    expect(dashboardPrintLayout(Number.NaN, 0)).toEqual(dashboardPrintLayout(1920, 1080));
  });
});
