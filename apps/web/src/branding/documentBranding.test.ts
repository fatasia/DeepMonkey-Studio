import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PRODUCT_BRANDING } from "@bim-studio/contracts";
import { accentForeground, applyDocumentBranding } from "./documentBranding";

afterEach(() => vi.unstubAllGlobals());

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

describe("one brand accent source", () => {
  it("uses the existing gold brand before settings load, with primary aliases following runtime accent", () => {
    const css = readFileSync(new URL("../styles/base.css", import.meta.url), "utf8");
    expect(css).toContain(`--accent: ${DEFAULT_PRODUCT_BRANDING.primaryColor};`);
    expect(css).toContain("--accent-primary: var(--accent);");
    expect(css).toContain("--accent-primary-hover: var(--accent-hover);");
    expect(css).not.toMatch(/--accent:\s*var\(--accent-primary\)/);
  });

  it.each(["dark", "light"] as const)("applies one gold accent in %s while retaining its readable foreground", themeMode => {
    const setProperty = vi.fn();
    const icon = { href: "" };
    const root = { style: { setProperty, colorScheme: "" }, dataset: { theme: "" } };
    vi.stubGlobal("document", { documentElement: root, querySelector: () => icon, title: "" });
    applyDocumentBranding({ ...DEFAULT_PRODUCT_BRANDING, themeMode });
    expect(setProperty).toHaveBeenCalledWith("--accent", "#d6aa4d");
    expect(setProperty).toHaveBeenCalledWith("--on-accent", "var(--on-accent-dark)");
    expect(setProperty).not.toHaveBeenCalledWith("--accent-primary", expect.anything());
    expect(root.dataset.theme).toBe(themeMode);
  });
});
