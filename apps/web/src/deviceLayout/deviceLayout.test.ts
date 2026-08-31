import { describe, expect, it } from "vitest";
import { createDeviceGrid, parseDeviceLayoutText, toDeviceGeoJson, transformDeviceLayout } from "./deviceLayout";

describe("device layout", () => {
  it("creates a deterministic box grid and exports local-coordinate GeoJSON", () => {
    const devices = createDeviceGrid({
      rows: 2, columns: 2, spacingX: 4, spacingZ: 6,
      originX: 10, originY: 0, originZ: 20,
      width: 2, height: 3, depth: 1.5, prefix: "泵", color: "#15803d"
    });
    expect(devices).toHaveLength(4);
    expect(devices[3]).toMatchObject({ id: "泵-004", position: { x: 14, y: 0, z: 26 } });
    expect(toDeviceGeoJson(devices).features[3]).toMatchObject({
      geometry: { type: "Point", coordinates: [14, 26, 0] },
      properties: { equipmentId: "泵-004", width: 2, height: 3, depth: 1.5, coordinateOrder: "X,Z,Y" }
    });
    expect(transformDeviceLayout([devices[0]!], { offsetX: 100, offsetY: 2, offsetZ: -20, scale: 0.5 })[0]).toMatchObject({
      position: { x: 105, y: 2, z: -10 }, size: { width: 1, height: 1.5, depth: 0.75 }
    });
  });

  it("imports CSV with Chinese headers and preserves business properties", () => {
    const result = parseDeviceLayoutText("设备编号,设备名称,坐标X,坐标Y,坐标Z,宽度,高度,深度,状态\nP-01,循环泵,1,0,2,2,3,4,运行");
    expect(result.issues).toEqual([]);
    expect(result.devices[0]).toMatchObject({
      id: "P-01", name: "循环泵", position: { x: 1, y: 0, z: 2 },
      size: { width: 2, height: 3, depth: 4 }, properties: { 状态: "运行" }
    });
  });

  it("converts a drawing-derived polygon to a box footprint", () => {
    const result = parseDeviceLayoutText(JSON.stringify({
      type: "FeatureCollection",
      features: [{ type: "Feature", id: "M-01", properties: { name: "机床", height: 2.5 }, geometry: { type: "Polygon", coordinates: [[[0, 0], [6, 0], [6, 3], [0, 3], [0, 0]]] } }]
    }));
    expect(result.issues).toEqual([]);
    expect(result.devices[0]).toMatchObject({
      id: "M-01", position: { x: 3, y: 0, z: 1.5 }, size: { width: 6, height: 2.5, depth: 3 }
    });
  });

  it("reports bad rows instead of creating invalid scene objects", () => {
    const result = parseDeviceLayoutText("id,x,z\nbad,not-a-number,3\nmissing,1,");
    expect(result.devices).toEqual([]);
    expect(result.issues[0]).toContain("必须是有限数字");
    expect(result.issues[1]).toContain("缺少Z 坐标");
  });
});
