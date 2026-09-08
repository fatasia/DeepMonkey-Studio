import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./ScenePlantPlayback.css", import.meta.url), "utf8");
describe("scene simulation timeline layout budget", () => {
  it("keeps the clock and footer non-shrinking while the schematic can yield space", () => {
    expect(css).toMatch(/\.scene-simulation-timeline \.plant-playback > :is\(header,footer,\.plant-playback-timeline\)\s*\{\s*flex:none/);
    expect(css).toMatch(/\.scene-simulation-timeline \.plant-playback-stage\s*\{\s*flex:0 1 126px;\s*min-height:100px/);
    expect(css).toMatch(/\.scene-simulation-timeline > \.plant-playback\s*\{[^}]*min-height:0;\s*overflow:visible/);
  });
  it("scopes the fix to scene simulation without increasing the floating panel's viewport budget", () => {
    expect(css).not.toMatch(/max-height\s*:/);
    expect(css).not.toMatch(/(?:^|\n)\.plant-playback\s*\{/);
  });
});
