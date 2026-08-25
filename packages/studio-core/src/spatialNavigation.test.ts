import { describe, expect, it } from "vitest";
import type { SpatialNavigationDocument } from "@bim-studio/contracts";
import { SpatialNavigationSession } from "./spatialNavigation.js";

const navigation: SpatialNavigationDocument = {
  rootNodeIds: ["campus"],
  cacheLimit: 3,
  nodes: [
    { id: "campus", name: "智造园区", kind: "campus", sceneId: "scene-campus", dashboardPageId: "page-campus", loadPolicy: "replace" },
    { id: "workshop", name: "一号车间", kind: "workshop", parentId: "campus", sceneId: "scene-workshop", dashboardPageId: "page-workshop", loadPolicy: "additive" },
    { id: "line", name: "总装线", kind: "line", parentId: "workshop", sceneId: "scene-line", dashboardPageId: "page-line", loadPolicy: "additive" },
    { id: "robot", name: "机器人 A", kind: "equipment", parentId: "line", sceneId: "scene-line", target: { modelId: "robot-a" }, loadPolicy: "focus" }
  ]
};

describe("SpatialNavigationSession", () => {
  it("builds the full breadcrumb when a deep link opens directly", () => {
    const session = new SpatialNavigationSession(navigation, "robot");
    expect(session.breadcrumb().map((node) => node.id)).toEqual(["campus", "workshop", "line", "robot"]);
    expect(session.current().target).toEqual({ modelId: "robot-a" });
  });

  it("restores the exact parent workspace state after returning", () => {
    const session = new SpatialNavigationSession(navigation);
    const campusCamera = { position: { x: 10, y: 20, z: 30 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" as const };
    session.open("workshop", { camera: campusCamera, activePanel: "overview", editorTab: "dashboard" });
    const transition = session.back({ activePanel: "devices", editorTab: "scene" });
    expect(transition?.toNode.id).toBe("campus");
    expect(transition?.restoreState).toEqual({ camera: campusCamera, activePanel: "overview", editorTab: "dashboard" });
  });

  it("uses one path for sibling switches and keeps state per spatial node", () => {
    const session = new SpatialNavigationSession(navigation, "line");
    session.open("robot", { activePanel: "line-kpis" });
    session.open("line", { activePanel: "robot-health" });
    expect(session.breadcrumb().map((node) => node.id)).toEqual(["campus", "workshop", "line"]);
    expect(session.stateFor("robot")).toEqual({ activePanel: "robot-health" });
  });

  it("rejects cycles and undeclared roots before a host starts loading assets", () => {
    expect(() => new SpatialNavigationSession({
      rootNodeIds: ["a"], cacheLimit: 0,
      nodes: [
        { id: "a", name: "A", kind: "campus", parentId: "b", loadPolicy: "replace" },
        { id: "b", name: "B", kind: "building", parentId: "a", loadPolicy: "additive" }
      ]
    })).toThrow(/根节点不能有父节点|循环/);
  });
});
