import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";
import { DashboardFieldSlots } from "./DashboardFieldSlots";

const state = vi.hoisted(() => ({ type: "bar" as DashboardDataWidgetConfig["type"], locked: false }));
vi.mock("./dashboardWorkspaceContext", () => ({ useDashboardWorkspace: () => ({
  selectedNode: { id: "chart", kind: "data-widget", locked: state.locked, widget: { type: state.type, title: "产量", unit: "件", datasetId: "production", key: "production.amount", field: "amount" } },
  page: { id: "page" }, locale: "zh-CN", busy: false, onCommand: vi.fn(),
}) }));
vi.mock("./DashboardDataBindingProvider", () => ({ useDashboardDataBinding: () => ({
  products: [{ key: "dataset:production", name: "生产数据", status: "ready", fields: [{ key: "amount", label: "产量", type: "number", unit: "件" }] }],
  status: "ready", setOpen: vi.fn(), loadPipeline: vi.fn(),
}) }));

describe("dashboard field slot presentation", () => {
  it("exposes three chart roles and an explicitly named unbind control", () => {
    state.type = "bar"; state.locked = false;
    const html = renderToStaticMarkup(<DashboardFieldSlots />);
    expect(html.match(/data-field-role=/g)).toHaveLength(3);
    expect(html).toContain('aria-label="指标：产量"');
    expect(html).toContain('aria-label="解绑指标"');
    expect(html).toContain('aria-haspopup="listbox"');
  });
  it("keeps only a numeric slot for cards and does not replace report editors", () => {
    state.type = "value";
    expect(renderToStaticMarkup(<DashboardFieldSlots />).match(/data-field-role=/g)).toHaveLength(1);
    state.type = "table";
    expect(renderToStaticMarkup(<DashboardFieldSlots />)).toBe("");
  });
  it("disables both selection and unbinding for a locked layer", () => {
    state.type = "value"; state.locked = true;
    expect(renderToStaticMarkup(<DashboardFieldSlots />).match(/disabled=""/g)).toHaveLength(2);
    state.locked = false;
  });
});
