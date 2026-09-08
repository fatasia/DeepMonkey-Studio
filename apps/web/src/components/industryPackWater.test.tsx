import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { assertApplicationDocument, migrateSceneSnapshotV1, type SceneSnapshot } from "@bim-studio/contracts";
import { ApplicationStore, createInsertDashboardPagesCommand } from "@bim-studio/studio-core";
import fixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { buildIndustryPackImport } from "./industryPackImport";
import { WATER_TREATMENT_PACK as pack } from "./industryPackWater";
import { WATER_PACK_SAMPLES } from "./industryPackWaterSamples";
import { DashboardWidgetView } from "./DashboardWidgetRuntime";
import { buildDashboardSampleMetric } from "./dashboardSampleMetrics";

function rows(id: string) {
  const spec = WATER_PACK_SAMPLES[id]!;
  return spec.rowValues.map(values => Object.fromEntries(spec.columns.map((column, index) => [column.key, values[index]])));
}
const sum = (records: ReturnType<typeof rows>, field: string) => records.reduce((total, row) => total + Number(row[field]), 0);

describe("water treatment business pack", () => {
  it("reconciles overview counts with operation, quality, risk and asset ledgers", () => {
    // 总览管网告警与风险台账未结条数对账；2#厂浊度+余氯两条、3#厂泵故障一条。
    for (const overview of rows("water")) {
      expect(sum(rows("water-risk").filter(row => row["水厂"] === overview["水厂"]), "管网告警")).toBe(overview["管网告警"]);
    }
    expect(sum(rows("water"), "管网告警")).toBe(3);
    // 2#厂水质超标两项与两条未结风险对账（浊度接近限值+余氯偏低）。
    expect(sum(rows("water-quality").filter(row => row["水厂"] === "2#水厂"), "超标项")).toBe(2);
    // 3#厂故障加压泵：运行台账停运、资产健康评分不及格，三处口径一致。
    const stopped = rows("water-operations").find(row => row["泵组"] === "1#加压泵")!;
    const asset = rows("water-asset").find(row => row["设备"] === "1#加压泵")!;
    expect(stopped["状态"]).toBe("故障");
    expect(Number(stopped["停运泵组"])).toBe(1);
    expect(Number(asset["健康评分"])).toBeLessThan(70);
    // 告警台账每条管网告警只能是未结 1/已处置 0。
    for (const row of rows("water-risk")) expect(Number(row["管网告警"])).toBe(Number(row["已处置"]) === 0 ? 1 : 0);
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
      const html = renderToStaticMarkup(<DashboardWidgetView locale={locale} widget={node.widget}
        metric={buildDashboardSampleMetric(node.widget, node.widget.sampleData!.rows)} compact={false}
        onDataInteraction={() => {}} onAnimationStart={() => {}} onAnimationEnd={() => {}} />);
      expect(html).toContain("dashboard-report-table");
    }
    store.undo();
    expect(store.getState().document).toEqual(before);
  });
  it("keeps the plant linkage value domain consistent across all pages", () => {
    const options = WATER_PACK_SAMPLES["water"]!.filterOptions;
    for (const [id, spec] of Object.entries(WATER_PACK_SAMPLES)) {
      expect(spec.filterKey, id).toBe("pack:water-treatment:plant");
      for (const row of spec.rowValues) expect(spec.filterOptions.includes(String(row[0])), `${id}:${row[0]}`).toBe(true);
    }
  });
});
