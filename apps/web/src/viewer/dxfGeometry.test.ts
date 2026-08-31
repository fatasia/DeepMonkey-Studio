import { describe, expect, it } from "vitest";
import { dxfDrawingExtents, dxfPoints, dxfUnitName, dxfUnitScale, pointsIntersectExtents } from "./dxfGeometry";

describe("DXF geometry", () => {
  it("converts drawing units to metres", () => {
    expect(dxfUnitScale(4)).toBe(0.001);
    expect(dxfUnitScale(6)).toBe(1);
    expect(dxfUnitName(2)).toBe("foot");
  });

  it("creates deterministic arc samples and rejects geometry outside extents", () => {
    const points = dxfPoints({ type: "ARC", center: { x: 0, y: 0 }, radius: 2, startAngle: 0, endAngle: Math.PI });
    expect(points).toHaveLength(49);
    const extents = dxfDrawingExtents({ "$EXTMIN": { x: -3, y: -1 }, "$EXTMAX": { x: 3, y: 3 } });
    expect(extents).toBeDefined();
    expect(pointsIntersectExtents(points, extents!)).toBe(true);
    expect(pointsIntersectExtents(dxfPoints({ vertices: [{ x: 20, y: 20 }, { x: 21, y: 21 }] }), extents!)).toBe(false);
  });
});
