// Explicit synthetic layout fixture for producer integration, not a production DOM capture.
export function dataFixture(document, bytes, sha256, contentHash) {
  document.application.scripts = []; document.application.interactions = [];
  document.application.pages = [document.application.pages[0]];
  const page = document.application.pages[0]; page.width = 960; page.height = 540;
  const node = (id, type, title, x, width, unit = "") => ({ id, kind: "data-widget", zIndex: 0,
    frame: { x, y: 30, width, height: 240 }, widget: { type, title, key: id, unit } });
  const kpi = node("real-kpi", "value", "利用率", 20, 280, "%");
  const table = node("real-table", "table", "区域统计", 330, 300);
  table.widget.report = { mode: "grouped", rowField: "region", valueField: "amount", aggregation: "sum",
    showGrandTotal: true, valueFormat: "number", decimalPlaces: 1 };
  const chart = node("real-chart", "bar", "产量", 660, 280);
  page.nodes = [kpi, table, chart];
  const clip = [17.25, 12.5, 260.125, 170.75];
  const box = (role, x, y, width = 95.25) => ({ role, rect: [x, y, width, 26], clip,
    wrap: "none", whiteSpace: "nowrap", verticalAlign: "center", fonts: ["font"], style: {
      fontSize: 18, fontWeight: 400, fontStyle: "normal", lineHeight: 24, color: [238, 242, 244, 255], align: "left" } });
  const freeze = (id, metric, boxes) => ({ source: { kind: "dataset", id, revision: 1, contentSha256: contentHash(metric) },
    metric, ...(boxes ? { layout: { textBoxes: boxes, backgrounds: [] } } : {}) });
  const kpiData = freeze("kpi-source", { value: 81.6666, samples: [] }, [
    box({ kind: "title" }, 17.6, 17.6, 200), box({ kind: "value" }, 17.6, 62.4), box({ kind: "unit" }, 120.2, 62.4, 30)]);
  const tableData = freeze("table-source", { rows: [{ region: "A", amount: 2 }, { region: "A", amount: 3 }], samples: [] }, [
    box({ kind: "title" }, 17.6, 17.6, 200),
    box({ kind: "header", column: "region" }, 17.6, 50.2), box({ kind: "sort", column: "region" }, 112.6, 50.2, 20),
    box({ kind: "header", column: "amount" }, 150.4, 50.2), box({ kind: "sort", column: "amount" }, 246.4, 50.2, 20),
    box({ kind: "cell", row: 0, column: "region" }, 17.6, 84.8), box({ kind: "cell", row: 0, column: "amount" }, 150.4, 84.8),
    box({ kind: "total", column: "region" }, 17.6, 120.3), box({ kind: "total", column: "amount" }, 150.4, 120.3)]);
  tableData.table = { page: 0, scrollLeft: 0 };
  return { document, packageId: "c2.real-data", packageVersion: "1.0.0", locale: "zh-CN", nodeAssets: {},
    assets: { font: { bytes, sha256, faceIndex: 0, mime: "font/collection", identity: { id: "test-only-system-font", revision: 1 } } },
    data: { "real-kpi": kpiData, "real-table": tableData,
      "real-chart": freeze("chart-source", { samples: [{ time: 0, value: 7 }, { time: 1, value: 9 }] }) } };
}
