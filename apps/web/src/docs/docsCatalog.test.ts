import { describe, expect, it } from "vitest";
import { docsCategories, docsDocuments, docsLinkIssues, DOCS_VERSION } from "./docsCatalog.js";

describe("local documentation catalog", () => {
  it("ships the four M9 task guides offline", () => {
    expect(docsDocuments.map((document) => document.id)).toEqual([
      "dashboard-scene",
      "behavior-script",
      "server-publish",
      "agv-runtime-simulation"
    ]);
    expect(docsDocuments.every((document) => document.version === DOCS_VERSION)).toBe(true);
    expect(docsCategories).toHaveLength(4);
  });

  it("has no broken local Markdown links", () => {
    expect(docsLinkIssues).toEqual([]);
  });
});
