import { describe, expect, it } from "vitest";
import { docsPath, parseDocsPath } from "./docsRoute.js";

describe("documentation route", () => {
  it("round-trips a document identifier", () => {
    expect(parseDocsPath(docsPath("行为-script"))).toEqual({ documentId: "行为-script" });
    expect(docsPath("behavior-script", "创建行为脚本")).toBe("/docs/behavior-script#%E5%88%9B%E5%BB%BA%E8%A1%8C%E4%B8%BA%E8%84%9A%E6%9C%AC");
  });

  it("accepts the index and rejects malformed or nested paths", () => {
    expect(parseDocsPath("/docs")).toEqual({});
    expect(parseDocsPath("/docs/")).toEqual({});
    expect(parseDocsPath("/docs/a/b")).toBeUndefined();
    expect(parseDocsPath("/docs/%E0%A4%A")).toBeUndefined();
  });
});
