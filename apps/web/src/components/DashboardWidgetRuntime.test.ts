import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { mergeDirectBindingMetric, mergeProductMetrics } from "./dashboardMetrics";
import {
  applyDashboardFilters,
  buildDashboardHierarchy,
  dashboardLinkageValue,
  DashboardWidgetView,
  filterDashboardDrillRows,
  widgetBackgroundStyle,
} from "./DashboardWidgetRuntime";

vi.mock("../api", () => ({ api: {} }));

describe("mergeProductMetrics", () => {
  it("uses the same product.field metric key for pipeline and dataset outputs", () => {
    const rows = [{ cycle_time: 12.4 }, { cycle_time: 13.1 }];
    const metrics = mergeProductMetrics({}, "pipeline-cycle", [{ key: "cycle_time", label: "节拍", type: "number", unit: "s" }], rows);

    expect(metrics["pipeline-cycle.cycle_time"]).toMatchObject({
      value: 12.4,
      rows,
      samples: [{ value: 13.1 }, { value: 12.4 }],
    });
  });
});

describe("dashboard parameters", () => {
  it("keeps a component background image independent from image-widget media", () => {
    expect(
      widgetBackgroundStyle({ title: "KPI", key: "kpi", unit: "", type: "value", componentBackgroundImageUrl: "/assets/frame.webp", componentBackgroundImageFit: "stretch" }),
    ).toMatchObject({
      backgroundImage: 'url("/assets/frame.webp")',
      backgroundSize: "100% 100%",
      backgroundRepeat: "no-repeat",
    });
  });
  it("filters dataset rows by shared parameter and configured field", () => {
    const rows = [{ region: "华东", value: 10 }, { region: "华北", value: 20 }, { value: 30 }];
    const widgets = [{ title: "地区", key: "area", type: "filter" as const, unit: "", filterField: "region", options: ["全部", "华东", "华北"] }];
    expect(applyDashboardFilters(rows, { area: "华东" }, widgets)).toEqual([rows[0]]);
    expect(applyDashboardFilters(rows, { area: "全部" }, widgets)).toEqual(rows);
  });

  it("fails honestly for missing bindings and keeps exact and contains distinct", () => {
    const rows = [{ site: { name: "上海一厂" } }, { site: { name: "上海二厂" } }, { region: "上海" }];
    const filter = { title: "工厂", key: "factory", type: "filter" as const, unit: "", filterField: "site.name", filterMode: "text" as const };
    expect(applyDashboardFilters(rows, { factory: "一厂" }, [filter])).toEqual([rows[0]]);
    expect(applyDashboardFilters(rows, { factory: "上海" }, [{ ...filter, filterMatch: "exact" as const }])).toEqual([]);
  });

  it("does not apply a stale child filter while its parent is cleared", () => {
    const rows = [
      { region: "华东", city: "上海" },
      { region: "华北", city: "北京" },
    ];
    const widgets = [
      { title: "地区", key: "area", type: "filter" as const, unit: "", filterField: "region", options: ["全部", "华东", "华北"] },
      { title: "城市", key: "city", type: "filter" as const, unit: "", filterField: "city", parentFilterKey: "area", options: ["全部", "上海", "北京"] },
    ];

    expect(applyDashboardFilters(rows, { city: "上海" }, widgets)).toEqual(rows);
    expect(applyDashboardFilters(rows, { area: [], city: "上海" }, widgets)).toEqual(rows);
    expect(applyDashboardFilters(rows, { area: "华东", city: "上海" }, widgets)).toEqual([rows[0]]);
  });

  it("supports multi-select and text-search controls without custom scripts", () => {
    const rows = [
      { region: "华东", device: "循环水泵 A" },
      { region: "华北", device: "空压机 B" },
      { region: "华南", device: "循环水泵 C" },
    ];
    const widgets = [
      { title: "地区", key: "regions", type: "filter" as const, unit: "", filterField: "region", filterMode: "multi-select" as const },
      { title: "设备", key: "keyword", type: "filter" as const, unit: "", filterField: "device", filterMode: "text" as const },
    ];
    expect(applyDashboardFilters(rows, { regions: ["华东", "华南"], keyword: "水泵" }, widgets)).toEqual([rows[0], rows[2]]);
  });

  it("extracts a stable cross-component linkage value from chart payloads", () => {
    expect(dashboardLinkageValue({ name: "华东", value: 12 })).toBe("华东");
    expect(dashboardLinkageValue({ value: 12 })).toBe(12);
  });

  it("filters hierarchical rows across drill levels", () => {
    const rows = [
      { region: "华东", site: { city: "上海" } },
      { region: "华东", site: { city: "杭州" } },
      { region: "华北", site: { city: "北京" } },
    ];
    expect(
      filterDashboardDrillRows(rows, [
        { field: "region", value: "华东" },
        { field: "site.city", value: "上海" },
      ]),
    ).toEqual([rows[0]]);
  });

  it("builds a reusable multi-level hierarchy from drill fields", () => {
    expect(
      buildDashboardHierarchy(
        [
          { region: "华东", city: "上海", category: "泵", amount: 12 },
          { region: "华东", city: "上海", category: "阀", amount: 8 },
          { region: "华东", city: "杭州", category: "泵", amount: 5 },
          { region: "华南", city: "深圳", category: "泵", amount: 7 },
        ],
        ["region", "city", "category"],
        "amount",
      ),
    ).toEqual([
      {
        name: "华东",
        value: 25,
        children: [
          {
            name: "上海",
            value: 20,
            children: [
              { name: "泵", value: 12 },
              { name: "阀", value: 8 },
            ],
          },
          { name: "杭州", value: 5, children: [{ name: "泵", value: 5 }] },
        ],
      },
      { name: "华南", value: 7, children: [{ name: "深圳", value: 7, children: [{ name: "泵", value: 7 }] }] },
    ]);
  });
});

describe("direct binding dashboard metrics", () => {
  it("writes a gateway value under the widget key and preserves rows for table widgets", () => {
    const rows = [{ temperature: 28.2 }, { temperature: 27.9 }];
    const metrics = mergeDirectBindingMetric({}, "device.temperature", 28.2, rows, 1_700_000_000_000);

    expect(metrics["device.temperature"]).toEqual({
      value: 28.2,
      samples: [{ time: 1_700_000_000_000, value: 28.2 }],
      rows,
    });
  });
});

describe("industrial dashboard widgets", () => {
  const handlers = { onDataInteraction: () => undefined, onAnimationStart: () => undefined, onAnimationEnd: () => undefined };

  it("renders a bound digital flip value and unit", () => {
    const html = renderToStaticMarkup(
      createElement(DashboardWidgetView, {
        locale: "zh-CN",
        widget: { title: "瞬时流量", key: "flow", type: "digital-flip", unit: "m³/h", fontSize: 42 },
        metric: { value: 128.6, samples: [] },
        compact: false,
        ...handlers,
      }),
    );
    expect(html).toContain("dashboard-digital-flip");
    expect(html).toContain('aria-label="瞬时流量: 128.6m³/h"');
    expect(html).toContain("m³/h");
  });

  it("renders a bounded SVG liquid level", () => {
    const html = renderToStaticMarkup(
      createElement(DashboardWidgetView, {
        locale: "zh-CN",
        widget: { title: "储罐液位", key: "level", type: "liquid-fill", unit: "m", min: 0, max: 20 },
        metric: { value: 15, samples: [] },
        compact: false,
        ...handlers,
      }),
    );
    expect(html).toContain("dashboard-liquid-fill");
    expect(html).toContain("75%");
    expect(html).toContain("<svg");
  });

  it("renders a data-bound scrolling table with configured visible rows", () => {
    const html = renderToStaticMarkup(
      createElement(DashboardWidgetView, {
        locale: "zh-CN",
        widget: { title: "告警滚动表", key: "alarms", type: "scroll-table", unit: "", report: { mode: "detail", pageSize: 2 } },
        metric: {
          value: 3,
          samples: [],
          rows: [
            { device: "P-01", level: "高" },
            { device: "P-02", level: "中" },
            { device: "P-03", level: "低" },
          ],
        },
        compact: false,
        ...handlers,
      }),
    );
    expect(html).toContain("dashboard-scroll-table-track running");
    expect(html).toContain("P-01");
    expect(html).toContain("device");
  });

  it("renders multi-measure crosstabs with row and grand totals", () => {
    const html = renderToStaticMarkup(
      createElement(DashboardWidgetView, {
        locale: "zh-CN",
        widget: {
          title: "区域经营",
          key: "sales",
          type: "table",
          unit: "",
          report: { mode: "crosstab", rowField: "region", columnField: "month", valueFields: ["sales", "cost"], aggregation: "sum", showSubtotal: true, showGrandTotal: true },
        },
        metric: {
          value: 30,
          samples: [],
          rows: [
            { region: "华东", month: "1月", sales: 10, cost: 4 },
            { region: "华东", month: "2月", sales: 20, cost: 8 },
          ],
        },
        compact: false,
        ...handlers,
      }),
    );
    expect(html).toContain("1月 · sales");
    expect(html).toContain("行总计 · cost");
    expect(html).toContain("30");
    expect(html).toContain("12");
  });

  it("renders an explicit table empty state after filters remove every row", () => {
    const html = renderToStaticMarkup(
      createElement(DashboardWidgetView, {
        locale: "zh-CN",
        widget: { title: "区域经营", key: "sales", type: "table", unit: "" },
        metric: { value: undefined, samples: [], rows: [] },
        compact: false,
        ...handlers,
      }),
    );
    expect(html).toContain("dashboard-design-state empty");
    expect(html).toContain("暂无数据");
  });
});
