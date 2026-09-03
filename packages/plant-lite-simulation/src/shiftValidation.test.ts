import { describe, expect, it } from "vitest";
import { createAgvLinePlantLiteModel, validatePlantLiteModel } from "./index.js";

describe("Plant Lite shift-window validation", () => {
  it("accepts adjacent windows and blocks overlapping daily shifts", () => {
    const model = createAgvLinePlantLiteModel();
    const station = model.nodes.find((node) => node.kind === "station");
    if (!station || station.kind !== "station") throw new Error("missing station fixture");
    station.availability = { shifts: [{ startMinute: 0, endMinute: 480 }, { startMinute: 480, endMinute: 960 }] };
    expect(validatePlantLiteModel(model)).toMatchObject({ valid: true });

    station.availability.shifts[1] = { startMinute: 450, endMinute: 960 };
    expect(validatePlantLiteModel(model)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([expect.objectContaining({
        path: expect.stringContaining("availability.shifts"),
        message: expect.stringContaining("时间重叠"),
      })]),
    });
  });

  it("bounds the daily editor/runtime contract to eight windows", () => {
    const model = createAgvLinePlantLiteModel();
    const station = model.nodes.find((node) => node.kind === "station");
    if (!station || station.kind !== "station") throw new Error("missing station fixture");
    station.availability = {
      shifts: Array.from({ length: 9 }, (_, index) => ({ startMinute: index * 100, endMinute: index * 100 + 60 })),
    };
    expect(validatePlantLiteModel(model)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([expect.objectContaining({ message: "每日班次窗口不能超过 8 个" })]),
    });
  });
});
