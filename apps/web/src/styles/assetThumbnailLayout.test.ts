import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./unified-asset-library.css", import.meta.url), "utf8");
const rule = (selector: string) => css.split(`${selector} {`)[1]?.split("}")[0] ?? "";

describe("asset thumbnail layout contract", () => {
  it("bounds intrinsic image sizing inside both normal and compact preview tracks", () => {
    expect(rule(".unified-asset-preview:not(.built-in-asset-preview)")).toMatch(/grid-template:\s*minmax\(0,1fr\)\s*\/\s*minmax\(0,1fr\)/);
    expect(rule(".unified-asset-preview")).not.toContain("grid-template");
    expect(rule(".unified-asset-preview img")).toMatch(/min-width:\s*0/);
    expect(rule(".unified-asset-preview img")).toMatch(/min-height:\s*0/);
    expect(rule(".unified-asset-preview img")).toMatch(/object-fit:\s*contain/);
    expect(rule(".unified-asset-preview img")).not.toContain("filter:");
    expect(rule(".asset-thumbnail-image")).toMatch(/opacity:\s*0/);
    expect(rule(".asset-thumbnail-image.is-ready")).toMatch(/opacity:\s*1/);
    expect(rule(".asset-workspace-active .unified-asset-preview")).toMatch(/aspect-ratio:\s*16\s*\/\s*9/);
  });

  it("keeps environment panoramas covering their preview instead of changing model fitting", () => {
    expect(rule(".unified-asset-card.dimension-environment .unified-asset-preview img")).toMatch(/object-fit:\s*cover/);
  });
});
