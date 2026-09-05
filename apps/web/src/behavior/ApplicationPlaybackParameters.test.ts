import { describe, expect, it } from "vitest";
import { migrateSceneSnapshotV1, type SceneSnapshot, type DashboardDataWidgetConfig } from "@bim-studio/contracts";
import fixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { ApplicationPlaybackState } from "./ApplicationPlaybackState";
import { dashboardParameterOrder } from "../components/dashboardParameterOrder";

describe("playback parameter ownership", () => {
  it("clears all descendants across pages without modifying the author document or input values", () => {
    const app = migrateSceneSnapshotV1(fixture as SceneSnapshot);
    const config = (key: string, parentFilterKey?: string): DashboardDataWidgetConfig => ({ type: "filter", title: key, key, unit: "", ...(parentFilterKey ? { parentFilterKey } : {}) });
    app.pages = [config("semantic.model.parameter.region"), config("semantic.model.parameter.factory", "semantic.model.parameter.region"), config("equipment", "semantic.model.parameter.factory")].map((widget, index) => ({
      id: String(index), name: String(index), width: 1000, height: 700, viewportFit: "contain", nodes: [{ id: widget.key, kind: "data-widget", name: widget.key, zIndex: 1, frame: { x: 0, y: 0, width: 200, height: 100 }, widget }],
    }));
    const before = structuredClone(app);
    const filters = { "semantic.model.parameter.region": "西", "semantic.model.parameter.factory": "一厂", equipment: "设备一", unrelated: "保留" };
    const state = new ApplicationPlaybackState(app, {}, filters);
    const next = ["东"];
    state.setFilter("semantic.model.parameter.region", next);
    next.push("北");
    expect(state.filters).toEqual({ "semantic.model.parameter.region": ["东"], unrelated: "保留" });
    expect(filters.equipment).toBe("设备一");
    expect(app).toEqual(before);
    state.setFilter("semantic.model.parameter.region", undefined);
    expect(state.filters).toEqual({ unrelated: "保留" });
    const reversed = app.pages.flatMap((page) => page.nodes.flatMap((node) => node.kind === "data-widget" ? [node.widget] : [])).reverse();
    for (const widget of dashboardParameterOrder(reversed)) state.setFilter(widget.key, filters[widget.key as keyof typeof filters]);
    expect(state.filters).toEqual(filters);
  });
});
