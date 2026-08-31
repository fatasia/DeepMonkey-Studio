import { describe, expect, it } from "vitest";
import { ServerRequestError } from "@bim-studio/server-sdk";
import { workspaceSaveFailureGuidance } from "./workspaceSaveProtection";

describe("workspaceSaveFailureGuidance", () => {
  it("turns a revision conflict into explicit non-destructive guidance", () => {
    const result = workspaceSaveFailureGuidance(
      new ServerRequestError("应用已被其他修改更新", 409, { currentRevision: 8 }),
      "zh-CN"
    );

    expect(result).toMatchObject({ pauseAutoSave: true });
    expect(result?.message).toContain("服务器版本 v8");
    expect(result?.message).toContain("不会覆盖服务器");
    expect(result?.message).toContain("本页修改仍保留");
  });

  it("does not classify an offline failure as a revision conflict", () => {
    expect(workspaceSaveFailureGuidance(new TypeError("Failed to fetch"), "zh-CN")).toBeUndefined();
  });
});
