import { describe, expect, it } from "vitest";
import { annotationLabelPresentation } from "./annotationLabelPresentation";

const base = {
  verticalFovDegrees: 50,
  viewportHeightPx: 900,
  authoredSize: 1,
  hasDescription: true,
  selected: false,
};

describe("annotationLabelPresentation", () => {
  it("keeps a default label readable across common authoring distances", () => {
    const near = annotationLabelPresentation({ ...base, distance: 8 });
    const far = annotationLabelPresentation({ ...base, distance: 50 });

    expect(near.estimatedHeightPx).toBeGreaterThanOrEqual(45);
    expect(far.estimatedHeightPx).toBeGreaterThanOrEqual(35);
    expect(far.scaleMultiplier).toBeGreaterThan(near.scaleMultiplier);
    expect(far.visible).toBe(true);
  });

  it("fades and hides an unselected label instead of scaling it without limit", () => {
    const distant = annotationLabelPresentation({ ...base, distance: 240 });

    expect(distant.scaleMultiplier).toBe(3.4);
    expect(distant.visible).toBe(false);
    expect(distant.opacity).toBe(0);
  });

  it("keeps a selected distant label visible while preserving authored size priority", () => {
    const selected = annotationLabelPresentation({ ...base, distance: 180, selected: true });
    const small = annotationLabelPresentation({ ...base, distance: 30, authoredSize: 0.35 });
    const large = annotationLabelPresentation({ ...base, distance: 30, authoredSize: 3 });

    expect(selected.visible).toBe(true);
    expect(selected.estimatedHeightPx).toBeGreaterThanOrEqual(45);
    expect(large.estimatedHeightPx).toBeGreaterThan(small.estimatedHeightPx);
  });
});
