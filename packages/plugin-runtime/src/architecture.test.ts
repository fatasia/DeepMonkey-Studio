import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("plugin runtime architecture boundary", () => {
  it("stays independent from UI, render engines and host code loading", () => {
    const sourceDirectory = new URL(".", import.meta.url);
    const productionSources = readdirSync(sourceDirectory)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "fixtures.ts")
      .map((name) => readFileSync(new URL(name, sourceDirectory), "utf8"))
      .join("\n");

    expect(productionSources).not.toMatch(/from\s+["'](?:react|three|@tauri-apps\/|node:)/);
    expect(productionSources).not.toMatch(/\b(?:fetch|eval|Function)\s*\(/);
    expect(productionSources).not.toMatch(/import\s*\(\s*(?!["'][.])/);
  });
});
