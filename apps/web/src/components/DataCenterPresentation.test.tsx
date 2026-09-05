import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DatasetPreview, formatCell } from "./DataCenterPresentation";

describe("DatasetPreview", () => {
  it("localizes only typed datetimes and preserves invalid values and ordinary identifiers", () => {
    const iso = "2026-08-06T10:49:58.113327+08:00";
    const formatted = formatCell(iso, "datetime", "zh-CN");
    expect(formatted).toContain("2026");
    expect(formatted).not.toContain("T");
    expect(formatted).not.toContain("113327");
    expect(formatCell(iso, "string")).toBe(iso);
    expect(formatCell("2026-not-a-date", "datetime")).toBe("2026-not-a-date");
    expect(formatCell(null, "datetime")).toBe("—");
    expect(formatCell({ count: 2 })).toBe('{"count":2}');
  });
  it("distinguishes an unselected dataset from a selected dataset that has not run", () => {
    const unselected = renderToStaticMarkup(<DatasetPreview locale="zh-CN" />);
    const selected = renderToStaticMarkup(<DatasetPreview locale="zh-CN" datasetName="设备运行趋势" />);

    expect(unselected).toContain("选择一个数据集");
    expect(unselected).toContain("从左侧选择数据集，然后运行查询");
    expect(selected).toContain("尚未运行查询");
    expect(selected).toContain("运行“设备运行趋势”后将在此显示字段和前 100 行数据");
    expect(selected).not.toContain("选择一个数据集");
  });
});
