import { describe, expect, it } from "vitest";
import { migrateSceneSnapshotV1, type DashboardDataWidgetConfig, type SceneSnapshot, type DataDatasetRecord } from "@bim-studio/contracts";
import fixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { dashboardDraftPageContext, validateDashboardDraft } from "./dashboardDraft";

const document = migrateSceneSnapshotV1(fixture as SceneSnapshot), page = document.pages[0]!;
const dataset: DataDatasetRecord = { id: "actual", projectId: document.metadata.projectId, connectionId: "connection", name: "实际产量", createdAt: "now", updatedAt: "now", refreshSeconds: 0, fields: [{ key: "output", label: "产量", type: "number" }, { key: "line", label: "产线", type: "string" }] };
const add = { op: "add", id: "generated", frame: { x: 40, y: 40, width: 360, height: 180 }, widget: { type: "bar", title: "产量", key: "output", unit: "件", datasetId: "actual", field: "output", analysis: { aggregation: "sum", dimensionField: "line" } } };
const draft = (changes: unknown[]) => ({ version: 1, pageId: page.id, changes });
describe("AI canvas proposal validation", () => {
  it("resolves actual fields and derives the chart measure from the binding", () => {
    const result = validateDashboardDraft(draft([add]), document, page, [dataset]);
    expect(result.diff[0]!.after!.widget.analysis).toEqual({ aggregation: "sum", dimensionField: "line", measureField: "output" });
    expect(result.diff[0]!.after!.widget.key).toBe("actual.output");
    expect(result.command?.payload.changes).toHaveLength(1);
    expect(page.nodes.some(node => node.id === "generated")).toBe(false);
  });
  it("addresses table rows by a real dataset field and rejects rebinding an existing linked key", () => {
    const table = validateDashboardDraft(draft([{ ...add, widget: { type: "table", title: "明细", key: "guessed", unit: "", datasetId: dataset.id } }]), document, page, [dataset]);
    expect(table.diff[0]!.after!.widget.key).toBe("actual.output");
    const node = validateDashboardDraft(draft([add]), document, page, [dataset]).diff[0]!.after!;
    const populated = { ...page, nodes: [node] }, app = { ...document, pages: [populated] };
    expect(() => validateDashboardDraft(draft([{ op: "update", id: node.id, widget: { datasetId: "second" } }]), app, populated, [dataset, { ...dataset, id: "second" }])).toThrow(/key|数据键/);
  });
  it("rejects unknown schema, forbidden properties and invalid numeric geometry", () => {
    for (const raw of [{ version: 2, pageId: page.id, changes: [] }, { ...draft([]), pageId: "other" }, { ...draft([]), scripts: [] }, draft([{ ...add, op: "execute" }]), draft([{ ...add, frame: { ...add.frame, width: NaN } }]), draft([{ ...add, widget: { ...add.widget, url: "https://bad.invalid" } }])]) {
      expect(() => validateDashboardDraft(raw, document, page, [dataset])).toThrow();
    }
  });
  it("rejects absent/foreign datasets, unknown fields and nonnumeric metric bindings", () => {
    for (const widget of [{ ...add.widget, datasetId: "missing" }, { ...add.widget, field: "invented" }, { ...add.widget, field: "line" }]) expect(() => validateDashboardDraft(draft([{ ...add, widget }]), document, page, [dataset])).toThrow();
    expect(() => validateDashboardDraft(draft([add]), document, page, [{ ...dataset, projectId: "other" }])).toThrow();
  });
  it("treats empty changes as a no-op and never fabricates sample values", () => {
    expect(validateDashboardDraft(draft([]), document, page, [dataset])).toEqual({ diff: [], command: undefined });
    expect(() => validateDashboardDraft(draft([{ ...add, widget: { ...add.widget, sampleData: { rows: [{ output: 999 }] } } }]), document, page, [dataset])).toThrow();
  });
  it("does not send sample rows, direct-binding headers or script-like content to the model", () => {
    const context = dashboardDraftPageContext({ ...page, nodes: [{ ...add, kind: "data-widget", zIndex: 1,
      widget: { ...add.widget, type: "bar", unit: "件", directBinding: { headers: { Authorization: "secret" } } as never, sampleData: { rows: [{ output: 999 }] } as never } as DashboardDataWidgetConfig }] });
    expect(JSON.stringify(context)).not.toContain("secret"); expect(JSON.stringify(context)).not.toContain("999");
    expect(context.nodes[0]!.editable).toBe(false);
  });
});
