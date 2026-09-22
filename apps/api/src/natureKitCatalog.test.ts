import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadNatureKitEntries } from "./natureKitCatalog.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("Nature Kit catalog", () => {
  it("loads the staged 48-model V11 selection with audited geometry", async () => {
    const entries = await loadNatureKitEntries(path.resolve(repoRoot, "apps/web/public/assets/nature-kit"));
    expect(entries).toHaveLength(48);
    expect(new Set(entries.map(entry => entry.publicItem.subcategory))).toEqual(new Set(["树木", "灌木", "围栏", "地面"]));
    expect(entries.every(entry => entry.publicItem.publicationStatus === "published" && entry.modelPath)).toBe(true);
  });
});
