import { describe, expect, it } from "vitest";
import source from "../../../../packages/contracts/fixtures/application-v2-worker-behavior.json";
import { assertApplicationDocument, createDashboardDocument } from "@bim-studio/contracts";
import { compileDashboardLayout, compileDashboardLayouts } from "./compileDashboardLayout";
import { readFileSync } from "node:fs";

function fixture() { const app = structuredClone(source); assertApplicationDocument(app); return createDashboardDocument(app, "page-main"); }

describe("DashboardDocument outer layout pass", () => {
  it("batch compilation matches single-page layouts and isolates the source snapshot", () => {
    const input = fixture(), second = structuredClone(input.application.pages[0]!);
    second.id = "page-second";
    second.nodes[0]!.id = "node-second";
    input.application.pages.push(second);
    input.entryPageId = second.id;
    const batch = compileDashboardLayouts(input);
    expect(batch.pages.map(page => ({ tree: page.tree, layout: page.layout, bindings: page.nodeBindings })))
      .toEqual(input.application.pages.map(page => {
        const result = compileDashboardLayout(input, page.id);
        return { tree: result.tree, layout: result.layout, bindings: result.nodeBindings };
      }));
    expect(batch.pages.every(page => page.source === batch.source)).toBe(true);
    const originalX = second.nodes[0]!.frame.x;
    input.application.pages[1]!.nodes[0]!.frame.x += 100;
    expect(batch.source.application.pages[1]!.nodes[0]!.frame.x).toBe(originalX);
  });
  it("recompiles the shared Native outer-layout golden", () => {
    const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../../packages/deep-engine/fixtures/${name}.json`, import.meta.url), "utf8"));
    const result = compileDashboardLayout(read("dashboard-layout-source-v1"));
    expect({ tree: result.tree, layout: result.layout }).toEqual(read("dashboard-layout-v1"));
  });
  it("uses the real retained layout engine and preserves uncompiled content", () => {
    const input = fixture(), node = input.application.pages[0]!.nodes[0]!;
    node.frame = { x: 120.5, y: 32, width: 480, height: 300 }; node.zIndex = 7; node.visible = false;
    const result = compileDashboardLayout(input), binding = result.nodeBindings[0]!;
    expect(result.layout.frames.find(frame => frame.id === binding.layoutId)).toMatchObject({ ...node.frame, zIndex: 7 });
    expect(result.tree.nodes[1]!.style.visible).toBe(false);
    expect(binding.deferredFields).toEqual(expect.arrayContaining(["sceneId", "renderMode", "interactionPolicy"]));
    expect(result.deferredPageFields).toContain("viewportFit");
    expect(result.source).toEqual(input);
    input.application.pages[0]!.nodes = []; input.application.scripts = [];
    expect(result.source.application.pages[0]!.nodes).toHaveLength(1);
    expect(result.source.application.scripts).toHaveLength(1);
  });
  it("keeps object identities stable when frames change", () => {
    const input = fixture(), before = compileDashboardLayout(input);
    input.application.pages[0]!.nodes[0]!.frame.x += 1;
    input.application.metadata.revision += 1;
    const after = compileDashboardLayout(input);
    expect(after.nodeBindings[0]!.layoutId).toBe(before.nodeBindings[0]!.layoutId);
    expect(after.tree.revision).toBe(before.tree.revision + 1);
    expect(after.layout.frames[1]!.x).toBe(before.layout.frames[1]!.x + 1);
  });
  it("preserves array order for equal z indices", () => {
    const input = fixture(), page = input.application.pages[0]!;
    page.nodes.push({ ...structuredClone(page.nodes[0]!), id: "second" });
    const result = compileDashboardLayout(input);
    expect(result.layout.frames.slice(1).map(frame => frame.id)).toEqual(result.nodeBindings.map(binding => binding.layoutId));
  });
  it("rejects missing pages and coordinates outside the runtime contract", () => {
    expect(() => compileDashboardLayout(fixture(), "missing")).toThrow("页面不存在");
    const input = fixture(); input.application.pages[0]!.nodes[0]!.frame.x = 16_777_217;
    expect(() => compileDashboardLayout(input)).toThrow("Retained UI 契约");
  });
});
