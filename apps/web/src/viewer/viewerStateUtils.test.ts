import { describe, expect, it } from "vitest";
import { ellipsize, formatMeasurementState, normalizeAnnotation, sameRuntimeInteractionTarget } from "./viewerStateUtils";

describe("viewer state utilities", () => {
  it("normalizes authored annotations without mutating the source", () => {
    const source = { id: "a1", name: " ", description: " note ", position: { x: 0, y: 0, z: 0 }, color: "invalid", visible: true, locked: false, size: 99 };
    const result = normalizeAnnotation(source);
    expect(result).toMatchObject({ name: "未命名标签", description: "note", color: "#2f8fff", size: 3 });
    expect(source.name).toBe(" ");
  });

  it("formats measurements and compares interaction targets by stable identity", () => {
    expect(formatMeasurementState({ id: "m1", kind: "distance", start: { x: 0, y: 0, z: 0 }, end: { x: 0.5, y: 0, z: 0 }, distance: 0.5 })).toBe("500 mm");
    expect(sameRuntimeInteractionTarget({ kind: "object", modelId: "m1", layerId: "l1" }, { kind: "object", modelId: "m1", layerId: "l1" })).toBe(true);
    expect(ellipsize("设备预测维护", 5)).toBe("设备预测…");
  });
});
