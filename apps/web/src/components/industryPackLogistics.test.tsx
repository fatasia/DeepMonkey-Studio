import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { assertApplicationDocument, migrateSceneSnapshotV1, type SceneSnapshot } from "@bim-studio/contracts";
import { ApplicationStore, createInsertDashboardPagesCommand } from "@bim-studio/studio-core";
import fixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { buildIndustryPackImport } from "./industryPackImport";
import { LOGISTICS_FULFILLMENT_PACK as pack } from "./industryPackLogistics";
import { LOGISTICS_PACK_SAMPLES } from "./industryPackLogisticsSamples";
import { DashboardWidgetView } from "./DashboardWidgetRuntime";
import { buildDashboardSampleMetric } from "./dashboardSampleMetrics";

function rows(id: string) {
  const spec = LOGISTICS_PACK_SAMPLES[id]!;
  return spec.rowValues.map(values => Object.fromEntries(spec.columns.map((column, index) => [column.key, values[index]])));
}
const sum = (records: ReturnType<typeof rows>, field: string) => records.reduce((total, row) => total + Number(row[field]), 0);

describe("warehouse fulfillment business pack", () => {
  it("reconciles summary counts with stock, picking, dispatch and exception ledgers", () => {
    for (const overview of rows("logistics")) {
      for (const [id, field] of [["logistics-asset", "可用库存"], ["logistics-operations", "待拣订单"],
        ["logistics-quality", "待发运单"], ["logistics-risk", "未结异常"]]) {
        expect(sum(rows(id!).filter(row => row["库区"] === overview["库区"]), field!)).toBe(overview[field!]);
      }
    }
    for (const row of rows("logistics-operations")) {
      expect(Number(row["已拣件数"]) + Number(row["待拣件数"])).toBe(row["计划拣选"]);
      expect(row["待拣订单"]).toBe(Number(Number(row["待拣件数"]) > 0));
    }
    for (const row of rows("logistics-quality")) expect(Number(row["已装箱数"]) + Number(row["未装箱数"])).toBe(row["计划箱数"]);
    expect(sum(rows("logistics"), "未结异常")).toBe(3);
    expect(sum(rows("logistics-operations"), "待拣件数")).toBe(180);
    expect(sum(rows("logistics-quality"), "未装箱数")).toBe(14);
  });
  it.each(["zh-CN", "en-US"] as const)("renders real editable tables and navigable pages in %s", locale => {
    const before = migrateSceneSnapshotV1(fixture as SceneSnapshot);
    const imported = buildIndustryPackImport(pack, locale, before.pages[0]!);
    const store = new ApplicationStore(before);
    store.dispatch(createInsertDashboardPagesCommand(imported.pages, imported.interactions));
    expect(() => assertApplicationDocument(store.getState().document)).not.toThrow();
    expect(imported.interactions).toHaveLength(5);
    expect(imported.pages).toHaveLength(5);
    for (const page of imported.pages) {
      expect(page.nodes).toHaveLength(10);
      const node = page.nodes.find(item => item.kind === "data-widget" && item.widget.type === "table")!;
      if (node.kind !== "data-widget") throw new Error("Missing data widget");
      const widget = node.widget;
      const html = renderToStaticMarkup(<DashboardWidgetView locale={locale} widget={widget}
        metric={buildDashboardSampleMetric(widget, widget.sampleData!.rows)} compact={false}
        onDataInteraction={() => {}} onAnimationStart={() => {}} onAnimationEnd={() => {}} />);
      expect(html).toContain("dashboard-report-table");
      for (const column of widget.sampleData!.columns!) expect(html).toContain(`${column.key}<i data-capture-role="sort"`);
      expect(html).toContain(">CSV</button>");
      expect(html).toContain(">Excel</button>");
    }
    store.undo();
    expect(store.getState().document).toEqual(before);
  });
});
