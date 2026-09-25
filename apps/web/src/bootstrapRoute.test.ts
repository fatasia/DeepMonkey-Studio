import { describe, expect, it } from "vitest";
import { isPublishedApplicationRoute } from "./bootstrapRoute";

describe("isPublishedApplicationRoute", () => {
  it.each(["/", "/studio", "/apps-old"])("keeps %s on the editor bootstrap path", (pathname) => {
    expect(isPublishedApplicationRoute(pathname)).toBe(false);
  });

  it.each(["/apps", "/apps/plant-overview"])("loads the published application for %s", (pathname) => {
    expect(isPublishedApplicationRoute(pathname)).toBe(true);
  });
});
