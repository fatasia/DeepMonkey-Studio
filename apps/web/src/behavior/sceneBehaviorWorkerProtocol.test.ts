import { describe, expect, it } from "vitest";
import { behaviorSourceLocation, isWorkerResponse } from "./sceneBehaviorWorkerProtocol";

describe("scene behavior Worker protocol", () => {
  it("accepts all supported behavior log levels without exposing extra fields", () => {
    for (const level of ["debug", "info", "warn", "error"] as const) {
      expect(isWorkerResponse({ type: "behavior.log", level, message: "状态" })).toBe(true);
    }
    expect(isWorkerResponse({ type: "behavior.log", level: "trace", message: "不允许" })).toBe(false);
  });

  it("maps module stack lines after the injected console prelude", () => {
    expect(behaviorSourceLocation(
      `Error: boom
    at onStart (industrial-studio-behavior-module%2Fone.mjs:5:9)`,
      "module/one",
    )).toEqual({ line: 3, column: 9 });
  });
});
