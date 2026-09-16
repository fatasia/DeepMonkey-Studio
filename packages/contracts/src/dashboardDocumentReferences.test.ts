import { describe, expect, it } from "vitest";
import source from "../fixtures/application-v2-worker-behavior.json";
import { assertApplicationDocument, type ApplicationDocument } from "./application.js";
import { createDashboardDocument } from "./dashboardDocument.js";

function application(): ApplicationDocument { const value = structuredClone(source); assertApplicationDocument(value); return value; }

describe("DashboardDocument internal references", () => {
  it("rejects unresolved viewport scenes and cameras", () => {
    const input = application(), node = input.pages[0]!.nodes[0]!;
    if (node.kind !== "scene-viewport") throw new Error("fixture");
    node.sceneId = "missing";
    expect(() => createDashboardDocument(input, "page-main")).toThrow("引用的场景不存在");
    node.sceneId = "scene-main"; node.cameraViewId = "missing";
    expect(() => createDashboardDocument(input, "page-main")).toThrow("相机视图不存在");
  });
  it.each(["page", "widget", "scene", "object"] as const)("rejects unresolved %s interaction sources", kind => {
    const input = application();
    input.interactions = [{ id: "flow", name: "Flow", enabled: true, trigger: "click", actions: [],
      source: kind === "object" ? { kind, sceneId: "scene-main", modelId: "missing" } : { kind, id: "missing" } }];
    expect(() => createDashboardDocument(input, "page-main")).toThrow("不存在");
  });
  it("accepts valid cross-page widget references while rejecting stale publication entries", () => {
    const input = application();
    input.pages.push({ ...structuredClone(input.pages[0]!), id: "page-other", nodes: [] });
    input.interactions = [{ id: "flow", name: "Flow", enabled: true, trigger: "click", actions: [], source: { kind: "widget", id: "widget-scene-main" } }];
    expect(() => createDashboardDocument(input, "page-other")).not.toThrow();
    input.publicationProfiles[0]!.entryPageId = "deleted";
    expect(() => createDashboardDocument(input, "page-other")).toThrow("发布配置");
  });
  it("rejects duplicate scene identities", () => {
    const input = application(); input.scenes.push(structuredClone(input.scenes[0]!));
    expect(() => createDashboardDocument(input, "page-main")).toThrow("场景 ID 重复");
  });
});
