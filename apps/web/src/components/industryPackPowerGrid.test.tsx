import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { assertApplicationDocument, migrateSceneSnapshotV1, type SceneSnapshot } from "@bim-studio/contracts";
import { ApplicationStore, createInsertDashboardPagesCommand } from "@bim-studio/studio-core";
import fixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { buildIndustryPackImport } from "./industryPackImport";
import { POWER_GRID_OPERATIONS_PACK as pack } from "./industryPackPowerGrid";
import { POWER_GRID_PACK_SAMPLES } from "./industryPackPowerGridSamples";
import { DashboardWidgetView } from "./DashboardWidgetRuntime";
import { buildDashboardSampleMetric } from "./dashboardSampleMetrics";

function rows(id: string) {
  const spec = POWER_GRID_PACK_SAMPLES[id]!;
  return spec.rowValues.map(values => Object.fromEntries(spec.columns.map((column, index) => [column.key, values[index]])));
}
const sum = (records: ReturnType<typeof rows>, field: string) => records.reduce((total, row) => total + Number(row[field]), 0);

describe("power grid operations business pack", () => {
  it("reconciles overview counts with operation, alert and asset ledgers", () => {
    // 总览峰值告警与告警台账未结条数对账；2#站 2 条、3#站 1 条、1#站已处置不计。
    for (const overview of rows("energy")) {
      expect(sum(rows("energy-risk").filter(row => row["变电站"] === overview["变电站"]), "峰值告警")).toBe(overview["峰值告警"]);
      expect(sum(rows("energy-operations").filter(row => row["变电站"] === overview["变电站"]), "峰值告警")).toBe(overview["峰值告警"]);
    }
    expect(sum(rows("energy"), "峰值告警")).toBe(3);
    // 同一班次同一变压器，运行负载率与资产台账一致；2#重载是本包业务故事。
    const operationT2 = rows("energy-operations").find(row => row["回路"] === "2#变压器")!;
    const assetT2 = rows("energy-asset").find(row => row["设备"] === "2#变压器")!;
    expect(operationT2["负载率"]).toBe(assetT2["负载率"]);
    expect(Number(assetT2["负载率"])).toBeGreaterThan(90);
    // 告警台账每条的峰值告警只能是未结 1/已处置 0。
    for (const row of rows("energy-risk")) expect(Number(row["峰值告警"])).toBe(Number(row["已处置告警"]) === 0 ? 1 : 0);
    expect(sum(rows("energy-asset"), "未闭缺陷")).toBe(3);
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
      for (const column of widget.sampleData!.columns!) expect(html).toContain(`${column.key}<i>`);
      expect(html).toContain(">CSV</button>");
      expect(html).toContain(">Excel</button>");
    }
    store.undo();
    expect(store.getState().document).toEqual(before);
  });
  it("keeps the substation linkage value domain consistent across all pages", () => {
    const options = POWER_GRID_PACK_SAMPLES["energy"]!.filterOptions;
    for (const [id, spec] of Object.entries(POWER_GRID_PACK_SAMPLES)) {
      expect(spec.filterKey, id).toBe("pack:power-grid-operations:substation");
      expect([...spec.filterOptions], id).toEqual(options);
      for (const row of spec.rowValues) expect(spec.filterOptions.includes(String(row[0])), `${id}:${row[0]}`).toBe(true);
    }
  });
});
