import { describe, expect, it, vi } from "vitest";
import { failWithResourceCleanup, runResourceCleanup } from "./resourceCleanup.js";

describe("runResourceCleanup", () => {
  it("attempts every operation and preserves failure order", () => {
    const last = vi.fn();
    try {
      runResourceCleanup("cleanup failed", [
        () => { throw new Error("first"); },
        () => { throw new Error("second"); },
        last,
      ]);
      throw new Error("expected cleanup failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors.map(value => (value as Error).message))
        .toEqual(["first", "second"]);
    }
    expect(last).toHaveBeenCalledOnce();
  });

  it("preserves the triggering failure when rollback also fails", () => {
    const original = new Error("allocation failed"), cleanup = new Error("destroy failed");
    try { failWithResourceCleanup(original, "staging failed", [() => { throw cleanup; }]); }
    catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors[0]).toBe(original);
      expect(((error as AggregateError).errors[1] as AggregateError).errors).toEqual([cleanup]);
    }
  });
});
