import { describe, expect, it } from "vitest";
import { formatDashboardMetricDisplay } from "./dashboardMetricDisplay";

const widget = { type: "value" as const, title: "指标", key: "metric", unit: "" };

describe("dashboard metric display", () => {
  it("数字卡限制显示精度并保留百分比原有口径", () => {
    expect(formatDashboardMetricDisplay(81.66666666666667, { ...widget, unit: "%" }, "zh-CN")).toBe("81.7");
    expect(formatDashboardMetricDisplay(95.13333333333333, { ...widget, unit: "%" }, "zh-CN")).toBe("95.1");
    expect(formatDashboardMetricDisplay(2.6666666666666665, { ...widget, unit: "h" }, "en-US")).toBe("2.67");
    expect(formatDashboardMetricDisplay(1.5, widget, "zh-CN")).toBe("1.50");
  });
  it("整数计数不添加小数，分组遵循 locale，负值可读", () => {
    expect(formatDashboardMetricDisplay(1200, widget, "en-US")).toBe("1,200");
    expect(formatDashboardMetricDisplay(-1234.567, widget, "de-DE")).toBe("-1.234,57");
    expect(formatDashboardMetricDisplay(0, widget, "zh-CN")).toBe("0");
  });
  it("不把数值字符串或业务文本重新解释为数值", () => {
    expect(formatDashboardMetricDisplay("0012", widget, "zh-CN")).toBe("0012");
    expect(formatDashboardMetricDisplay(false, widget, "zh-CN")).toBe("false");
    expect(formatDashboardMetricDisplay({ count: 2 }, widget, "zh-CN")).toBe('{"count":2}');
    expect(formatDashboardMetricDisplay(undefined, widget, "zh-CN")).toBe("—");
    for (const value of [NaN, Infinity, -Infinity]) expect(formatDashboardMetricDisplay(value, widget, "zh-CN")).toBe("—");
  });
});
