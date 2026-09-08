import { describe, expect, it } from "vitest";
import { assertApplicationDocument, migrateSceneSnapshotV1, type SceneSnapshot } from "@bim-studio/contracts";
import { ApplicationStore, createInsertDashboardPagesCommand, evaluateApplicationInteraction } from "@bim-studio/studio-core";
import fixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { buildIndustryPackImport } from "./industryPackImport";
import { INDUSTRY_TEMPLATE_PACKS } from "./industryTemplatePackCatalog";
import { dashboardSampleFilterWidgets, isolateCopiedDashboardSamples } from "./dashboardSampleMetrics";

const pack = INDUSTRY_TEMPLATE_PACKS[0]!;
const document = () => migrateSceneSnapshotV1(fixture as SceneSnapshot);

describe("industry pack import transaction", () => {
  it("moves only an empty application's default publication entry and undoes that change with the pack", () => {
    const before = document();
    before.pages[0]!.nodes = [];
    const imported = buildIndustryPackImport(pack, "zh-CN", before.pages[0]!);
    const store = new ApplicationStore(before);
    store.dispatch(createInsertDashboardPagesCommand(imported.pages, imported.interactions, 0, imported.entryPageId));
    expect(store.getState().document!.publicationProfiles).toEqual(before.publicationProfiles.map(profile => ({ ...profile, entryPageId: imported.entryPageId })));
    store.undo();
    expect(store.getState().document).toEqual(before);
    before.pages.push({ ...before.pages[0]!, id: "other" });
    expect(() => new ApplicationStore(before).dispatch(createInsertDashboardPagesCommand(imported.pages, imported.interactions, 0, imported.entryPageId))).toThrow(/单一空页面/);
  });
  it("imports all pages and actual navigation in a single undo/redo history entry", () => {
    const before = document();
    const imported = buildIndustryPackImport(pack, "zh-CN", before.pages[0]!);
    const store = new ApplicationStore(before);
    store.dispatch(createInsertDashboardPagesCommand(imported.pages, imported.interactions, 0));
    const after = store.getState().document!;
    expect(() => assertApplicationDocument(after)).not.toThrow();
    expect(after.pages[0]!.id).toBe(imported.entryPageId);
    expect(after.pages).toHaveLength(before.pages.length + 5);
    expect(new Set(imported.pages.map(page => page.templateSource!.instanceId)).size).toBe(1);
    for (const page of imported.pages) expect(page.templateSource).toMatchObject({ kind: "industry-pack", packId: pack.id, revision: pack.revision });
    expect(after.publicationProfiles).toEqual(before.publicationProfiles);
    for (const flow of imported.interactions) {
      expect(flow.source.kind === "widget" && imported.pages.some(page => page.nodes.some(node => node.id === (flow.source as { id: string }).id))).toBe(true);
      const result = evaluateApplicationInteraction(after, { source: flow.source, trigger: "click", timestamp: "test" });
      expect(result.effects[0]!.action.dashboardPageId).toBe(flow.actions[0]!.dashboardPageId);
      expect(imported.pages.some(page => page.id === flow.actions[0]!.dashboardPageId)).toBe(true);
    }
    expect(store.undo()).toBe(true);
    expect(store.getState().document).toEqual(before);
    expect(store.getState().canUndo).toBe(false);
    expect(store.redo()).toBe(true);
    expect(store.getState().document).toEqual(after);
  });
  it("isolates repeated imports, including filter keys, data sources, nodes and workflows", () => {
    const base = document().pages[0]!;
    const one = buildIndustryPackImport(pack, "zh-CN", base);
    const two = buildIndustryPackImport(pack, "zh-CN", base);
    const keys = (value: typeof one) => value.pages.flatMap(page => page.nodes.flatMap(node => node.kind === "data-widget" && node.widget.type === "filter" ? [node.widget.key] : []));
    expect(new Set(keys(one)).size).toBe(1);
    expect(keys(one)[0]).not.toBe(keys(two)[0]);
    expect(one.pages[0]!.templateSource!.instanceId).not.toBe(two.pages[0]!.templateSource!.instanceId);
    const widgets = [...one.pages, ...two.pages].flatMap(page => page.nodes.flatMap(node => node.kind === "data-widget" ? [node.widget] : []));
    const sample = widgets.find(widget => widget.sampleData)!;
    expect(new Set(dashboardSampleFilterWidgets(sample, widgets).map(widget => widget.key))).toEqual(new Set(keys(one)));
    const copied = isolateCopiedDashboardSamples(one.pages[0]!.nodes);
    const copyWidgets = copied.flatMap(node => node.kind === "data-widget" ? [node.widget] : []);
    const copyFilter = copyWidgets.find(widget => widget.type === "filter")!;
    const copySample = copyWidgets.find(widget => widget.sampleData)!;
    expect(copyFilter.key).not.toBe(keys(one)[0]);
    expect(copySample.sampleData!.sourceId!.startsWith(`${copyFilter.key}:page:`)).toBe(true);
    expect(dashboardSampleFilterWidgets(copySample, [...widgets, ...copyWidgets]).map(widget => widget.key)).toEqual([copyFilter.key]);
    const oneIds = new Set([...one.pages.flatMap(page => [page.id, ...page.nodes.map(node => node.id)]), ...one.interactions.map(flow => flow.id)]);
    expect(two.pages.flatMap(page => [page.id, ...page.nodes.map(node => node.id)]).some(id => oneIds.has(id))).toBe(false);
  });
  it("rejects a late invalid page without changing document, dirty state or history", () => {
    const before = document();
    const imported = buildIndustryPackImport(pack, "zh-CN", before.pages[0]!);
    imported.pages.at(-1)!.width = -1;
    const store = new ApplicationStore(before);
    expect(() => store.dispatch(createInsertDashboardPagesCommand(imported.pages, imported.interactions))).toThrow();
    expect(store.getState().document).toEqual(before);
    expect(store.getState()).toMatchObject({ dirty: false, canUndo: false, canRedo: false });
  });
  it("rejects duplicate identifiers and invalid insertion positions without partial state", () => {
    const before = document();
    const imported = buildIndustryPackImport(pack, "zh-CN", before.pages[0]!);
    const store = new ApplicationStore(before);
    expect(() => store.dispatch(createInsertDashboardPagesCommand(imported.pages, imported.interactions, 0.5))).toThrow(/位置/);
    imported.pages.at(-1)!.id = imported.pages[0]!.id;
    expect(() => store.dispatch(createInsertDashboardPagesCommand(imported.pages, imported.interactions))).toThrow(/重复/);
    expect(store.getState().document).toEqual(before);
  });
  it("rejects missing workflow targets before changing history", () => {
    const before = document();
    const imported = buildIndustryPackImport(pack, "zh-CN", before.pages[0]!);
    imported.interactions[0]!.actions[0]!.dashboardPageId = "missing";
    const store = new ApplicationStore(before);
    expect(() => store.dispatch(createInsertDashboardPagesCommand(imported.pages, imported.interactions))).toThrow(/目标页面不存在/);
    expect(store.getState()).toMatchObject({ document: before, dirty: false, canUndo: false });
  });
});
