import { describe, expect, it } from "vitest";
import {
  normalizeDashboardViewState,
  parseStudioWorkspacePath,
  readWorkspaceHistoryState,
  studioWorkspacePath,
  workspaceHistoryState
} from "./workspaceRoute.js";

describe("studio workspace routing", () => {
  it("round-trips project application page and scene locations", () => {
    const dashboard = { kind: "dashboard", projectId: "factory/a", applicationId: "app 1", pageId: "page:首页" } as const;
    const scene = { kind: "scene", projectId: "factory/a", applicationId: "app 1", sceneId: "scene:产线" } as const;

    expect(parseStudioWorkspacePath(studioWorkspacePath(dashboard))).toEqual(dashboard);
    expect(parseStudioWorkspacePath(studioWorkspacePath(scene))).toEqual(scene);
  });

  it("does not claim legacy or malformed routes", () => {
    expect(parseStudioWorkspacePath("/studio/legacy-scene-id")).toBeUndefined();
    expect(parseStudioWorkspacePath("/studio/project/applications/app/pages/%E0%A4%A")).toBeUndefined();
    expect(parseStudioWorkspacePath("/studio/project/applications/app/unknown/id")).toBeUndefined();
  });

  it("normalizes transient dashboard state without putting it in the URL", () => {
    expect(normalizeDashboardViewState({
      zoom: 9,
      scrollLeft: -4,
      scrollTop: 18,
      selectedNodeIds: ["node:1", "node:1", 3]
    })).toEqual({ zoom: 2, scrollLeft: 0, scrollTop: 18, selectedNodeIds: ["node:1"] });

    const history = workspaceHistoryState({
      dashboardReturn: {
        kind: "dashboard",
        projectId: "project",
        applicationId: "application",
        pageId: "page",
        view: { zoom: 0.75, scrollLeft: 120, scrollTop: 80, selectedNodeIds: ["widget"] }
      }
    });
    expect(readWorkspaceHistoryState(history).dashboardReturn).toMatchObject({
      projectId: "project",
      pageId: "page",
      view: { zoom: 0.75, scrollLeft: 120, scrollTop: 80, selectedNodeIds: ["widget"] }
    });

    const topologyHistory = workspaceHistoryState({
      topologyReturn: {
        kind: "dashboard",
        projectId: "project",
        applicationId: "application",
        pageId: "page",
        nodeId: "topology-widget",
        view: { zoom: 0.6, scrollLeft: 40, scrollTop: 30, selectedNodeIds: [] },
      },
    });
    expect(readWorkspaceHistoryState(topologyHistory).topologyReturn).toMatchObject({
      nodeId: "topology-widget",
      pageId: "page",
      view: { zoom: 0.6, scrollLeft: 40, scrollTop: 30 },
    });
  });
});
