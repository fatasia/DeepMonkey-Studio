import { afterEach, describe, expect, it, vi } from "vitest";
import { readRoute, routePath } from "../appRoute";
import { modelAssetLibraryRoute, modelAssetSceneRoute, readModelAssetQuery } from "./modelAssetNavigation";

afterEach(() => vi.unstubAllGlobals());
describe("contextual model routes", () => {
  it("round-trips source identity and typed scene context without redirect URLs", () => {
    const route = { view: "optimizer" as const, projectId: "p 1", modelId: "model/1", assetReturn: { sceneId: "scene/1", applicationId: "app 1" } };
    const path = routePath(route);
    const url = new URL(path, "https://studio.test");
    vi.stubGlobal("window", { location: url, history: { state: null } });
    expect(readRoute()).toEqual(route);
    expect(readModelAssetQuery(new URLSearchParams("returnUrl=https://attacker.test&returnScene=s"))).toEqual({});
    expect(readModelAssetQuery(new URLSearchParams("project=p&model=%00&returnScene=%00"))).toEqual({});
  });
  it("locates the new project model and carries only a one-shot local insertion", () => {
    const destination = { sceneId: "s", applicationId: "a" };
    expect(modelAssetLibraryRoute("p", "new", destination)).toEqual({ view: "manager", projectId: "p", managerTab: "assets", assetScope: "project", modelId: "new", assetReturn: destination });
    const path = routePath(modelAssetSceneRoute("p", destination, "new"));
    expect(path).toBe("/studio/p/applications/a/scenes/s?addModel=new");
    vi.stubGlobal("window", { location: new URL(path, "https://studio.test"), history: { state: null } });
    expect(readRoute()).toMatchObject({ view: "studio", projectId: "p", sceneId: "s", insertModelId: "new" });
  });
});
