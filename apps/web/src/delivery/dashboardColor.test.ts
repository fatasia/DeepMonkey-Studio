import { describe, expect, it } from "vitest";
import type { DashboardDataWidgetNode } from "@bim-studio/contracts";
import { cssSrgbToLinearColor } from "./dashboardColor";
import { lowerDashboardShape, parseHexColor } from "./dashboardShapeContent";
import { lowerDashboardWidget } from "./dashboardWidgetContent";

const node: DashboardDataWidgetNode = { id: "shape", kind: "data-widget", zIndex: 0,
  frame: { x: 0, y: 0, width: 200, height: 100 }, widget: {
    title: "", key: "shape", unit: "", type: "shape", color: "#80808080", borderWidth: 2, borderColor: "#808080",
    backgroundColor: "#80808080", backgroundOpacity: 0.5,
  } };
describe("dashboard CSS producer color encoding", () => {
  it("keeps CSS bytes for text rasterization while converting path RGB only", () => {
    expect(parseHexColor("#80808080")).toEqual([128 / 255, 128 / 255, 128 / 255, 128 / 255]);
    const linear = cssSrgbToLinearColor(parseHexColor("#80808080"));
    expect(linear[0]).toBeCloseTo(0.21586050011389926, 14);
    expect(linear[3]).toBe(128 / 255);
    expect(lowerDashboardShape(node).fill).toEqual(linear);
  });
  it("uses the transfer function threshold and keeps transparent RGB unpremultiplied", () => {
    expect(cssSrgbToLinearColor([0, 1, 0.04045, 0])).toEqual([0, 1, 0.04045 / 12.92, 0]);
    expect(cssSrgbToLinearColor([0.5, 0.5, 0.5, 0])[0]).toBeCloseTo(0.21404114048223255, 14);
  });
  it("converts both chrome fill and border but applies opacity only to alpha", () => {
    const commands = lowerDashboardWidget(node, "node.test", 1).commands;
    const fills = commands.filter(command => command.kind === "path" && command.fill);
    expect(fills[0]).toMatchObject({ fill: [0.21586050011389926, 0.21586050011389926, 0.21586050011389926, 64 / 255] });
    expect(commands.find(command => command.kind === "path" && command.stroke)).toMatchObject({
      stroke: [0.21586050011389926, 0.21586050011389926, 0.21586050011389926, 1] });
  });
  it.each([[1, 2, 0, 1], [NaN, 0, 0, 1], [0, 0, 0], [-1, 0, 0, 1]])("rejects invalid CSS components %j", (...color) => {
    expect(() => cssSrgbToLinearColor(color)).toThrow();
  });
});
