import { expect, it } from "vitest";
import { validateDashboardTables } from "./dashboardTableValidation.js";
import { input } from "./dashboardComposition.testUtils.js";

function fixture() {
  const pages = structuredClone(input().dashboard.pages);
  const node = pages[0]!.nodes.find(node => node.deep2d)!;
  const table = { id: "report", pageId: pages[0]!.id, nodeIds: [node.id], title: "报表", families: [{ orders: [{
    column: null, direction: null, exports: { csv: "YQ==", xlsx: "Yg==" }, pages: [{
      layers: [{ nodeId: node.id, deep2d: node.deep2d!, clip: null }],
      controls: [{ action: "csv", column: null, rect: [0, 0, 20, 20], enabled: true }],
    }],
  }] }] };
  return { pages, table };
}
it("reuses owned content and accounts new table views once", () => {
  const { pages, table } = fixture();
  expect(validateDashboardTables([table], pages, 1, "tables")).toEqual([]);
  table.families[0]!.orders[0]!.pages[0]!.layers[0]!.deep2d = "table.other";
  expect(validateDashboardTables([table], pages, 1, "tables")).toEqual(["table.other"]);
});
it("rejects foreign slots, family mismatch, invalid base64, controls and duplicate ownership", () => {
  for (const edit of [
    (table: ReturnType<typeof fixture>["table"]) => { table.nodeIds = ["missing"]; },
    (table: ReturnType<typeof fixture>["table"]) => { table.families = []; },
    (table: ReturnType<typeof fixture>["table"]) => { table.families[0]!.orders[0]!.exports.csv = "%%%"; },
    (table: ReturnType<typeof fixture>["table"]) => { table.families[0]!.orders[0]!.pages[0]!.controls[0]!.action = "delete"; },
    (table: ReturnType<typeof fixture>["table"]) => { table.families[0]!.orders[0]!.pages[0]!.controls[0]!.rect[2] = 0; },
  ]) {
    const { pages, table } = fixture(); edit(table);
    expect(() => validateDashboardTables([table], pages, 1, "tables")).toThrow();
  }
  const { pages, table } = fixture();
  expect(() => validateDashboardTables([table, { ...table, id: "second" }], pages, 1, "tables")).toThrow();
});
