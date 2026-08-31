import { describe, expect, it } from "vitest";
import type { ModelFormat, ModelRecord } from "@bim-studio/contracts";
import { appendInteractionLayerOptions, formatMeasurementValue, primitiveKindLabel, spacePropertyEntries, statusText } from "./appPresentation";

describe("app presentation", () => {
  it("formats authored domain values consistently in Chinese and English", () => {
    expect(primitiveKindLabel("cylinder", "zh-CN")).toBe("圆柱体");
    expect(formatMeasurementValue({ id: "m1", start: { x: 0, y: 0, z: 0 }, end: { x: 0.25, y: 0, z: 0 }, distance: 0.25 })).toBe("250 mm");
    expect(spacePropertyEntries({ id: "s1", modelId: "m1", modelName: "Factory", name: "Workshop", level: "L1", kind: "Space", areaSquareMetres: 12.5 }, "en-US"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: "Area", value: "12.5 m²" })]));
  });

  it("caps recursive interaction options at the caller limit", () => {
    const options: Array<{ label: string; target: { kind: "object"; modelId: string; layerId?: string } }> = [];
    appendInteractionLayerOptions(options, {
      id: "root", modelId: "m1", name: "Root", type: "Model", visible: true, locked: false, deleted: false,
      children: [
        { id: "a", modelId: "m1", name: "A", type: "Element", visible: true, locked: false, deleted: false, children: [] },
        { id: "b", modelId: "m1", name: "B", type: "Element", visible: true, locked: false, deleted: false, children: [] }
      ]
    }, "Model", 0, 1);
    expect(options).toHaveLength(1);
  });

  it("names the actual missing industrial converter", () => {
    expect(statusText(waitingModel("rvt"), false, "zh-CN")).toBe("等待 Revit 转换机");
    expect(statusText(waitingModel("x_t"), false, "zh-CN")).toBe("等待 Parasolid 转换器");
    expect(statusText(waitingModel("jt"), false, "en-US")).toBe("Waiting for JT converter");
  });
});

function waitingModel(format: ModelFormat): ModelRecord {
  return {
    id: `model-${format}`,
    projectId: "project-1",
    name: `sample.${format}`,
    format,
    size: 1,
    status: "waiting_converter",
    progress: 0,
    message: "waiting",
    sourceUrl: "/source",
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}
