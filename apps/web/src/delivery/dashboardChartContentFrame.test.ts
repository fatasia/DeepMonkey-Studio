import { expect, it } from "vitest";
import { dashboardChartContentFrame } from "./dashboardChartContentFrame";
import type { DashboardDataWidgetNode } from "@bim-studio/contracts";
import type { DashboardRasterCompileInput } from "./dashboardRasterTypes";

const node = { id: "chart", frame: { x: 100, y: 200, width: 400, height: 300 } } as DashboardDataWidgetNode;
it("reserves measured heading and unit height without changing author coordinates", () => {
  const input = { data: { chart: { layout: { textBoxes: [
    { role: { kind: "title" }, rect: [17, 17, 180, 24] },
    { role: { kind: "unit" }, rect: [250, 17, 40, 30] },
  ] } } } } as unknown as DashboardRasterCompileInput;
  expect(dashboardChartContentFrame(node, input)).toEqual([117, 264, 366, 219]);
});
it("keeps bounded padding when no heading was captured and rejects unusable space", () => {
  expect(dashboardChartContentFrame(node, {} as DashboardRasterCompileInput)).toEqual([117, 217, 366, 266]);
  expect(() => dashboardChartContentFrame({ ...node, frame: { ...node.frame, height: 40 } },
    {} as DashboardRasterCompileInput)).toThrow(/too small/);
});
