import { describe, expect, it } from "vitest";
import { visibleAnnotationLabelIds, type AnnotationLabelLayoutCandidate } from "./annotationLabelLayout";

function label(overrides: Partial<AnnotationLabelLayoutCandidate> = {}): AnnotationLabelLayoutCandidate {
  return {
    id: "label-a",
    centerX: 100,
    centerY: 100,
    width: 160,
    height: 48,
    distance: 10,
    selected: false,
    ...overrides,
  };
}

describe("visibleAnnotationLabelIds", () => {
  it("keeps a selected label when it overlaps a nearer ordinary label", () => {
    const visible = visibleAnnotationLabelIds([
      label({ id: "near", distance: 2 }),
      label({ id: "selected", distance: 20, selected: true }),
    ], 800, 600);

    expect([...visible]).toEqual(["selected"]);
  });

  it("keeps non-overlapping labels and removes off-screen noise", () => {
    const visible = visibleAnnotationLabelIds([
      label({ id: "first" }),
      label({ id: "second", centerX: 360 }),
      label({ id: "outside", centerX: -500 }),
    ], 800, 600);

    expect([...visible]).toEqual(["first", "second"]);
  });

  it("hides a partially clipped ordinary label but keeps a selected one available", () => {
    const visible = visibleAnnotationLabelIds([
      label({ id: "clipped", centerX: 790 }),
      label({ id: "selected", centerX: 790, selected: true }),
    ], 800, 600);

    expect([...visible]).toEqual(["selected"]);
  });

  it("uses distance and id as deterministic priorities", () => {
    const visible = visibleAnnotationLabelIds([
      label({ id: "z", distance: 10 }),
      label({ id: "b", distance: 4 }),
      label({ id: "a", distance: 4 }),
    ], 800, 600);

    expect([...visible]).toEqual(["a"]);
  });
});
