import { describe, expect, it } from "vitest";
import { migrateSceneSnapshotV1, type SceneSnapshot } from "@bim-studio/contracts";
import fixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { publicApplicationAction, publishedApplicationId, publishedEntryPage } from "./publishedApplicationModel";

describe("published application navigation", () => {
  it("accepts only a single path-safe application id", () => {
    expect(publishedApplicationId("/apps/app-123/" )).toBe("app-123");
    for (const path of ["/apps", "/apps/%", "/apps/%2e%2e", "/apps/a/b", "/apps/a%2fb", "/studio/a"]) expect(publishedApplicationId(path)).toBeUndefined();
  });
  it("uses the published entry profile and keeps navigation inside its pages", () => {
    const application = migrateSceneSnapshotV1(fixture as SceneSnapshot);
    const first = application.pages[0]!;
    application.pages.push({ ...first, id: "two" });
    application.publicationProfiles = [{ id: "web", name: "Web", target: "browser-preview", renderer: "auto", entryPageId: "two" }];
    expect(publishedEntryPage(application)?.id).toBe("two");
    expect(publicApplicationAction(application, { id: "go", enabled: true, type: "dashboard", dashboardPageId: "two" }, "https://test.invalid")).toEqual({ pageId: "two" });
    expect(publicApplicationAction(application, { id: "go", enabled: true, type: "dashboard", dashboardPageId: "missing" }, "https://test.invalid")).toHaveProperty("message");
    expect(publicApplicationAction(application, { id: "go", enabled: true, type: "navigateScene", sceneId: application.scenes[0]!.id }, "https://test.invalid")).toHaveProperty("pageId", first.id);
  });
  it("rejects executable URLs and tolerates an empty published document", () => {
    const application = migrateSceneSnapshotV1(fixture as SceneSnapshot);
    expect(publicApplicationAction(application, { id: "go", enabled: true, type: "openUrl", url: "javascript:alert(1)" }, "https://test.invalid")).toHaveProperty("message");
    expect(publicApplicationAction(application, { id: "go", enabled: true, type: "openUrl", url: "/docs" }, "https://test.invalid")).toEqual({ url: "https://test.invalid/docs" });
    application.pages = [];
    expect(publishedEntryPage(application)).toBeUndefined();
  });
});
