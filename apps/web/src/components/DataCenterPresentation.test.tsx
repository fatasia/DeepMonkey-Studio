import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DataDatasetPreview } from "@bim-studio/contracts";
import { ConnectorTrendBars, DatasetPreview, FieldStatBadges, formatCell, PreviewTable } from "./DataCenterPresentation";

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

  it("三态齐备:加载骨架(role=status)/错误(role=alert+重试)/空态互斥且形状贴合", () => {
    const busy = renderToStaticMarkup(<DatasetPreview locale="zh-CN" datasetName="遥测" busy />);
    expect(busy).toContain('role="status"');
    expect(busy).toContain("正在运行查询");
    expect(busy).toContain("data-preview-skeleton-row");
    const failed = renderToStaticMarkup(<DatasetPreview locale="zh-CN" error="连接 5xx:database down" onRetry={() => undefined} />);
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("连接 5xx:database down"); // 排障信息不截断
    expect(failed).toContain("重试查询");
  });

  it("字段统计卡:类型徽章/样例值/空值率可见,高空值率标警示", () => {
    const preview: DataDatasetPreview = {
      dataset: { id: "d1", name: "遥测", connectionId: "c1", projectId: "p1", query: "", refreshSeconds: 0, createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z", fields: [
        { key: "device_id", label: "设备", type: "string" },
        { key: "temperature", label: "温度", type: "number", unit: "°C" },
      ] },
      fields: [
        { key: "device_id", label: "设备", type: "string" },
        { key: "temperature", label: "温度", type: "number", unit: "°C" },
      ],
      rows: [
        { device_id: "Dev001", temperature: 42.5 },
        { device_id: null, temperature: null },
        { device_id: "Dev003", temperature: "" }, // 空串按空值计
      ],
      durationMs: 12,
    };
    const html = renderToStaticMarkup(<DatasetPreview locale="zh-CN" preview={preview} />);
    expect(html).toContain("data-field-type");
    expect(html).toContain("数值");
    expect(html).toContain("Dev001");
    expect(html).toContain("空值 33%");
    expect(html).toContain("空值 67%");
    expect(html).toContain("is-high"); // 67% 空值率标警示
    expect(html).toContain("显示第 1–3 行 / 共 3 行");
    expect(html).not.toContain('aria-hidden="true"'); // 行数少无需 spacer
  });

  it("虚拟滚动:大行集只渲染行窗+上下 spacer,行窗提示透出区间", () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ i: index }));
    const preview: DataDatasetPreview = {
      dataset: { id: "d1", name: "n", connectionId: "c1", projectId: "p1", query: "", refreshSeconds: 0, createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z", fields: [{ key: "i", label: "i", type: "number" }] },
      fields: [{ key: "i", label: "i", type: "number" }],
      rows,
      durationMs: 1,
    };
    const html = renderToStaticMarkup(<PreviewTable locale="zh-CN" preview={preview} />);
    const dataRows = (html.match(/<td>/g) ?? []).length;
    expect(dataRows).toBeLessThan(rows.length); // 窗口渲染,不铺满 100 行
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("共 100 行");
  });

  it("趋势条:失败样本标警示类,采样不足如实标注", () => {
    const few = renderToStaticMarkup(<ConnectorTrendBars samples={[]} locale="zh-CN" />);
    expect(few).toContain("样本采集中");
    const bars = renderToStaticMarkup(<ConnectorTrendBars locale="zh-CN" samples={[
      { at: "t1", latencyMs: 20, failures: 0 },
      { at: "t2", latencyMs: 80, failures: 2 },
    ]} />);
    expect(bars).toContain("has-failure");
    expect(bars).toContain("最近 2 次快照");
  });
});
