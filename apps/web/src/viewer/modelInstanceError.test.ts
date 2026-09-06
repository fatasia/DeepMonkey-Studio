import { describe, expect, it } from "vitest";
import { modelInstanceError } from "./modelInstanceError";

describe("model instance failure copy", () => {
  it("keeps HTTP status without exposing the full resource URL", () => {
    expect(modelInstanceError(new Error('fetch for "https://assets/path?key=secret" responded with 503: Service Unavailable'))).toBe("素材下载失败（503），请重试。");
    expect(modelInstanceError(new TypeError("Failed to fetch"))).toBe("素材下载失败，请检查网络后重试。");
  });
  it("never hides a failed rollback behind a success claim", () => {
    const message = "素材替换失败，原实例回滚也失败，请重新载入已保存场景：显存不足";
    expect(modelInstanceError(new AggregateError([], message))).toBe(message);
    expect(modelInstanceError(new Error("构件不兼容，原实例未修改"))).toBe("构件不兼容，原实例未修改");
  });
});
