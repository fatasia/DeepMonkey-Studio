import { describe, expect, it } from "vitest";
import { nextFrameCadence } from "./viewerFrameCadence";

describe("viewer frame cadence", () => {
  it("caps a high-refresh read-only viewer near 60 rendered frames per second", () => {
    let anchor: number | undefined;
    let rendered = 0;
    for (let frame = 0; frame <= 144; frame += 1) {
      const decision = nextFrameCadence((frame * 1_000) / 144, anchor, 60);
      anchor = decision.anchorMs;
      if (decision.render) rendered += 1;
    }
    expect(rendered).toBeGreaterThanOrEqual(60);
    expect(rendered).toBeLessThanOrEqual(62);
  });

  it("renders immediately when the cadence starts or the clock resets", () => {
    expect(nextFrameCadence(100, undefined, 60)).toEqual({ render: true, anchorMs: 100 });
    expect(nextFrameCadence(20, 100, 60)).toEqual({ render: true, anchorMs: 20 });
  });

  it("does not hide frames for an invalid target", () => {
    expect(nextFrameCadence(50, 40, 0).render).toBe(true);
  });
});
