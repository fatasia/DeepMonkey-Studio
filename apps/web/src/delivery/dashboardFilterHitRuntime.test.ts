import { describe, expect, it, vi } from "vitest";
import { migrateSceneSnapshotV1, type DashboardDataWidgetNode, type SceneSnapshot } from "@bim-studio/contracts";
import fixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { ApplicationPlaybackState } from "../behavior/ApplicationPlaybackState";
import { applyDashboardFilters } from "../components/DashboardWidgetRuntime";
import { lowerDashboardWidget } from "./dashboardWidgetContent";
import { dispatchDashboardFilterHit } from "./dashboardFilterHitRuntime";

vi.mock("../api", () => ({ api: {} }));

function filterNode(options = ["全部", "华东", "不存在"]): DashboardDataWidgetNode {
  return {
    id: "region-filter",
    kind: "data-widget",
    zIndex: 2,
    frame: { x: 10, y: 20, width: 220, height: 160 },
    widget: {
      type: "filter",
      title: "地区",
      key: "region-filter",
      unit: "",
      filterField: "site.region",
      filterMode: "select",
      options,
    },
  };
}

describe("compiled dashboard filter host bridge (G02 slices 2/3)", () => {
  it("routes a real compiled hit through playback state into nested-field data filtering and empty results", () => {
    const application = migrateSceneSnapshotV1(fixture as SceneSnapshot);
    const node = filterNode();
    application.pages[0]!.nodes.push(node);
    const state = new ApplicationPlaybackState(application);
    const lowering = lowerDashboardWidget(node, "runtime-filter", 4);
    const hitIds = lowering.commands.flatMap((command) => command.hitId ? [command.hitId] : []);
    const rows = [
      { site: { region: "华东" }, value: 12 },
      { site: { region: "华北" }, value: 18 },
      { value: 30 },
    ];

    expect(hitIds).toEqual([
      "region-filter:option:0",
      "region-filter:option:1",
      "region-filter:option:2",
    ]);
    expect(dispatchDashboardFilterHit(node, {
      source: "pointer",
      nodeId: node.id,
      widgetKey: node.widget.key,
      hitId: hitIds[1]!,
    }, state)).toMatchObject({ ok: true, command: { kind: "setFilter", value: "华东" } });
    expect(state.filters).toEqual({ "region-filter": "华东" });
    expect(applyDashboardFilters(rows, state.filters, [node.widget])).toEqual([rows[0]]);

    expect(dispatchDashboardFilterHit(node, {
      source: "key",
      key: "Enter",
      nodeId: node.id,
      widgetKey: node.widget.key,
      hitId: hitIds[2]!,
    }, state).ok).toBe(true);
    expect(applyDashboardFilters(rows, state.filters, [node.widget])).toEqual([]);
  });

  it("does not mutate playback state when the hit is rejected", () => {
    const application = migrateSceneSnapshotV1(fixture as SceneSnapshot);
    const node = filterNode();
    application.pages[0]!.nodes.push(node);
    const state = new ApplicationPlaybackState(application, {}, { "region-filter": "华北" });
    const onChange = vi.fn();
    state.onChange = onChange;

    expect(dispatchDashboardFilterHit(node, {
      source: "pointer",
      nodeId: node.id,
      widgetKey: node.widget.key,
      hitId: "region-filter:option:16",
    }, state)).toEqual({ ok: false, reason: "out-of-range" });
    expect(state.filters).toEqual({ "region-filter": "华北" });
    expect(onChange).not.toHaveBeenCalled();
  });
});
