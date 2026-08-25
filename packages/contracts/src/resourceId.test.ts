import { describe, expect, it } from "vitest";
import { assertPathSafeResourceId, isPathSafeResourceId } from "./resourceId.js";

describe("path-safe stable resource IDs", () => {
  it.each([
    "default",
    "scene-pure-3d",
    "3d3ae7ab-2a96-43c3-8354-2ba4d56cf8aa",
    "namespace:application-1",
    "fixture_value.1"
  ])("accepts %s", (value) => {
    expect(isPathSafeResourceId(value)).toBe(true);
    expect(() => assertPathSafeResourceId(value, "资源 ID")).not.toThrow();
  });

  it.each([
    "",
    ".",
    "..",
    "with/slash",
    "with\\backslash",
    "with?query",
    "with#fragment",
    "with%2fencoding",
    "with space",
    "a".repeat(129)
  ])("rejects %j", (value) => {
    expect(isPathSafeResourceId(value)).toBe(false);
    expect(() => assertPathSafeResourceId(value, "资源 ID")).toThrow("资源 ID");
  });
});
