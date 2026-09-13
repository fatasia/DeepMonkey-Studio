import { afterEach, describe, expect, it, vi } from "vitest";
import { readProjectContext, rememberProjectContext } from "./projectNavigationContext";

afterEach(() => vi.unstubAllGlobals());

describe("project navigation recovery", () => {
  it("keeps different accounts isolated and clears a removed project", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", { sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    } });
    rememberProjectContext("alice", "factory-a");
    rememberProjectContext("bob", "factory-b");
    expect(readProjectContext("alice")).toBe("factory-a");
    expect(readProjectContext("bob")).toBe("factory-b");
    rememberProjectContext("alice", undefined);
    expect(readProjectContext("alice")).toBeUndefined();
    expect(readProjectContext("bob")).toBe("factory-b");
  });

  it("does not block navigation when browser storage is unavailable", () => {
    vi.stubGlobal("window", { get sessionStorage() { throw new Error("storage disabled"); } });
    expect(() => rememberProjectContext("user", "factory")).not.toThrow();
    expect(readProjectContext("user")).toBeUndefined();
  });
});
