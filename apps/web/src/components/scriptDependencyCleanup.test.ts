import { describe, expect, it } from "vitest";
import { ServerRequestError } from "@bim-studio/server-sdk";
import { isRetainedScriptDependency } from "./scriptDependencyCleanup";
describe("script dependency historical retention", () => {
  it("recognizes retention but does not swallow other conflicts or network errors", () => {
    expect(isRetainedScriptDependency(new ServerRequestError("保留", 409, { code: "dependency-in-use" }))).toBe(true);
    expect(isRetainedScriptDependency(new ServerRequestError("冲突", 409, { code: "other" }))).toBe(false);
    expect(isRetainedScriptDependency(new Error("offline"))).toBe(false);
  });
});
