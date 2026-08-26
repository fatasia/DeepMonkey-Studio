import { describe, expect, it } from "vitest";
import { docsCategories, docsDocuments, docsLinkIssues, DOCS_VERSION } from "./docsCatalog.js";

describe("local documentation catalog", () => {
  it("ships the M9 task guides and media guide offline", () => {
    expect(docsDocuments.map((document) => document.id)).toEqual([
      "dashboard-scene",
      "media-widgets",
      "behavior-script",
      "studio-api",
      "server-publish",
      "agv-runtime-simulation"
    ]);
    expect(docsDocuments.every((document) => document.version === DOCS_VERSION)).toBe(true);
    expect(docsCategories).toHaveLength(5);
  });

  it("has no broken local Markdown links", () => {
    expect(docsLinkIssues).toEqual([]);
  });
});
