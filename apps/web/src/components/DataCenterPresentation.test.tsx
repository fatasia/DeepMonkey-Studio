import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DatasetPreview } from "./DataCenterPresentation";

describe("DatasetPreview", () => {
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
