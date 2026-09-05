import { describe, expect, it } from "vitest";
import { readRoute, routeHistoryState, routePath } from "./appRoute";

describe("app route", () => {
  it("round-trips the data center project through reloadable URLs", () => {
    expect(routePath({ view: "data", projectId: "factory / 2" })).toBe("/data?project=factory%20%2F%202");
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { pathname: "/data", search: "?project=factory%20%2F%202" }, history: { state: null } } });
    try { expect(readRoute()).toEqual({ view: "data", projectId: "factory / 2" }); }
    finally { Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow }); }
  });
  it("distinguishes canonical home from missing and malformed routes without throwing", () => {
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { pathname: "/", search: "" }, history: { state: null } } });
    try {
      for (const path of ["/", "/manager"]) {
        globalThis.window.location.pathname = path;
        expect(readRoute()).toEqual({ view: "manager" });
      }
      for (const path of ["/not-a-page", "/view/id/extra", "/view/%E0%A4%A", "/projects/p/applications/a/topologies/%E0%A4%A"]) {
        globalThis.window.location.pathname = path;
        expect(readRoute()).toEqual({ view: "manager", fallback: "not-found" });
      }
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    }
  });
  it("keeps dashboard and scene workspace identities in generated paths", () => {
    expect(routePath({ view: "dashboard", projectId: "project 1", applicationId: "app/1", pageId: "page 1" }))
      .toBe("/studio/project%201/applications/app%2F1/pages/page%201");
    expect(routePath({ view: "studio", projectId: "project 1", applicationId: "app/1", sceneId: "scene 1" }))
      .toBe("/studio/project%201/applications/app%2F1/scenes/scene%201");
  });

  it("keeps the selected operations task in a shareable route", () => {
    expect(routePath({ view: "operations", operationsTab: "commissioning" })).toBe(
      "/operations?task=commissioning",
    );
    expect(routePath({ view: "operations", operationsTab: "whatif" })).toBe("/operations?task=whatif");
  });

  it("restores only known operations tasks from the URL", () => {
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { pathname: "/operations", search: "?task=battery" },
        history: { state: null },
      },
    });
    try {
      expect(readRoute()).toEqual({ view: "operations", operationsTab: "battery" });
      globalThis.window.location.search = "?task=unknown";
      expect(readRoute()).toEqual({ view: "operations" });
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });

  it("serializes dashboard return context through the shared history contract", () => {
    const state = routeHistoryState({
      view: "studio",
      dashboardReturn: {
        kind: "dashboard",
        projectId: "project-1",
        applicationId: "app-1",
        pageId: "page-1",
        view: { zoom: 1, scrollLeft: 10, scrollTop: 20, selectedNodeIds: ["node-1"] }
      }
    });
    expect(state).toMatchObject({
      bimStudio: { dashboardReturn: { projectId: "project-1", applicationId: "app-1", pageId: "page-1" } }
    });
  });
});
