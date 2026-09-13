import { afterEach, describe, expect, it, vi } from "vitest";
import { readRoute, routePath } from "../appRoute";
import { modelAssetLibraryRoute, modelAssetOptimizerRoute, modelAssetSceneRoute, readModelAssetQuery } from "./modelAssetNavigation";

afterEach(() => vi.unstubAllGlobals());
describe("contextual model routes", () => {
  it("round-trips source identity and typed scene context without redirect URLs", () => {
    const route = { view: "optimizer" as const, projectId: "p 1", modelId: "model/1", assetReturn: { sceneId: "scene/1", applicationId: "app 1", instanceId: "instance/1" } };
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
  it("carries an exact scene instance for an in-place optimization replacement", () => {
    const destination = { sceneId: "s", applicationId: "a", instanceId: "instance/1" };
    const path = routePath(modelAssetSceneRoute("p", destination, "optimized"));
    expect(path).toBe("/studio/p/applications/a/scenes/s?addModel=optimized&replaceInstance=instance%2F1");
    vi.stubGlobal("window", { location: new URL(path, "https://studio.test"), history: { state: null } });
    expect(readRoute()).toMatchObject({ view: "studio", insertModelId: "optimized", replaceModelInstanceId: "instance/1" });
  });
  it("keeps the original scene destination when model import continues to optimization", () => {
    const destination = { sceneId: "scene", applicationId: "application" };
    expect(modelAssetOptimizerRoute("project", "uploaded", destination)).toEqual({
      view: "optimizer", projectId: "project", modelId: "uploaded", assetReturn: destination,
    });
  });
});
