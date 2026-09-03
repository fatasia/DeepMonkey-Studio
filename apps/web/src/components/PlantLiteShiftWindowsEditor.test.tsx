import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { nextShiftWindow, PlantLiteShiftWindowsEditor, shiftWindowsIssue } from "./PlantLiteShiftWindowsEditor";

describe("PlantLiteShiftWindowsEditor", () => {
  it("renders multiple daily windows with readable clock labels", () => {
    const html = renderToStaticMarkup(<PlantLiteShiftWindowsEditor
      label="启用工位班次约束"
      value={{ shifts: [{ startMinute: 0, endMinute: 480 }, { startMinute: 540, endMinute: 1020 }] }}
      onChange={() => undefined}
    />);
    expect(html).toContain("班次 1");
    expect(html).toContain("班次 2");
    expect(html).toContain("00:00–08:00");
    expect(html).toContain("09:00–17:00");
    expect(html).toContain("添加班次");
  });

  it("detects invalid and overlapping windows before a run", () => {
    expect(shiftWindowsIssue([{ startMinute: 480, endMinute: 360 }])).toContain("结束晚于开始");
    expect(shiftWindowsIssue([{ startMinute: 0, endMinute: 480 }, { startMinute: 450, endMinute: 960 }])).toContain("时间重叠");
    expect(shiftWindowsIssue([{ startMinute: 0, endMinute: 480 }, { startMinute: 480, endMinute: 960 }])).toBeUndefined();
  });

  it("suggests an adjacent eight-hour window without crossing the day", () => {
    expect(nextShiftWindow([{ startMinute: 0, endMinute: 480 }])).toEqual({ startMinute: 480, endMinute: 960 });
    expect(nextShiftWindow([{ startMinute: 960, endMinute: 1440 }])).toBeUndefined();
    expect(nextShiftWindow([{ startMinute: 600, endMinute: 1200 }])).toEqual({ startMinute: 1200, endMinute: 1440 });
  });
});
