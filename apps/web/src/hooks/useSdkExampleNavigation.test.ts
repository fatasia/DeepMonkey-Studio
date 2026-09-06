import { describe, expect, it } from "vitest";
import { sdkExampleDestination } from "./useSdkExampleNavigation";
import type { AppRoute } from "../appRoute";

const dashboard: AppRoute = { view: "dashboard", projectId: "p", applicationId: "a", pageId: "page" };
const identity = { userId: "user", projectId: "p", applicationId: "a" };

describe("SDK example return destination", () => {
  it("returns a copied editor route only for the same user, project and application", () => {
    const destination = sdkExampleDestination({ route: dashboard, userId: "user" }, identity);
    expect(destination).toEqual(dashboard);
    expect(destination).not.toBe(dashboard);
    expect(sdkExampleDestination({ route: { ...dashboard, view: "studio", sceneId: "scene" }, userId: "user" }, identity)?.sceneId).toBe("scene");
  });

  it.each([{}, { ...identity, userId: "different" }, { ...identity, projectId: "other" }, { ...identity, applicationId: "other" }])("rejects changed or missing identity %j", value => {
    expect(sdkExampleDestination({ route: dashboard, userId: "user" }, value)).toBeUndefined();
  });

  it("does not reuse stale applications from manager, docs, direct links or incomplete routes", () => {
    expect(sdkExampleDestination(undefined, identity)).toBeUndefined();
    for (const route of [{ view: "manager" }, { view: "docs" }, { ...dashboard, view: "published" }, { view: "dashboard", projectId: "p", applicationId: "a" }] as AppRoute[]) {
      expect(sdkExampleDestination({ route, userId: "user" }, identity)).toBeUndefined();
    }
  });
});
