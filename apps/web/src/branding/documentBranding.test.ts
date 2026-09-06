import { describe, expect, it } from "vitest";
import { accentForeground } from "./documentBranding";

describe("brand button foreground", () => {
  it.each(["#d6aa4d", "#3ec6c1", "#ffffff", "#fff", "#ABCDEF"])("uses dark text on %s", color => {
    expect(accentForeground(color)).toBe("var(--on-accent-dark)");
  });

  it.each(["#6750a4", "#17242b", "#000000", "#000"])("uses light text on %s", color => {
    expect(accentForeground(color)).toBe("var(--on-accent-light)");
  });

  it("keeps a safe token fallback for invalid colors", () => {
    expect(accentForeground("invalid")).toBe("var(--on-accent-dark)");
  });
});
