import { describe, expect, it } from "vitest";
import { migrateSceneSnapshotV1, type SceneSnapshot, type ScriptModule } from "@bim-studio/contracts";
import fixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { authorBehaviorDocument } from "./authorBehaviorDocument";

const script = (id: string): ScriptModule => ({ id, name: id, code: "function onStart() {}", apiVersion: "1.0", entrypoint: "behavior", runtime: "worker-sandbox", enabled: true, lifecycle: ["onStart"], capabilities: ["studio.runtime"], permissions: ["scene.read"] });
describe("author test document", () => {
  it("runs only the latest current draft without applying it to the author document", () => {
    const source = migrateSceneSnapshotV1(fixture as SceneSnapshot);
    source.scripts = [script("one"), script("two")];
    const original = structuredClone(source);
    const result = authorBehaviorDocument(source, { ...source.scripts[0]!, code: "function onStart(){ctx.log('latest')}" }, "current", {});
    expect(result.document.scripts.map(script => script.id)).toEqual(["one"]);
    expect(result.document.scripts[0]!.code).toContain("latest");
    result.document.scenes[0]!.name = "runtime";
    expect(source).toEqual(original);
    expect(authorBehaviorDocument(source, script("three"), "enabled", {}).document.scripts).toHaveLength(3);
  });
  it("does not silently run disabled, legacy or missing-target current scripts", () => {
    const source = migrateSceneSnapshotV1(fixture as SceneSnapshot);
    expect(() => authorBehaviorDocument(source, { ...script("off"), enabled: false }, "current", {})).toThrow("禁用");
    expect(() => authorBehaviorDocument(source, { ...script("missing"), target: { kind: "component", id: "absent" } }, "current", {})).toThrow("已不存在");
    expect(() => authorBehaviorDocument(source, { ...script("missing"), target: { kind: "object", id: "absent" } }, "current", {})).toThrow("已不存在");
    expect(() => authorBehaviorDocument(source, undefined, "current", {})).toThrow("选择");
  });
  it("opens the current component's page in the disposable run, not the author route", () => {
    const source = migrateSceneSnapshotV1(fixture as SceneSnapshot);
    source.pages = [{ id: "page", name: "page", width: 800, height: 600, viewportFit: "contain", nodes: [{ id: "target", kind: "data-widget", name: "target", zIndex: 0, frame: { x: 0, y: 0, width: 100, height: 100 }, widget: { type: "text", title: "author", key: "", unit: "" } }] }];
    expect(authorBehaviorDocument(source, { ...script("target"), target: { kind: "component", id: "target" } }, "current", {}).pageId).toBe("page");
  });
});
