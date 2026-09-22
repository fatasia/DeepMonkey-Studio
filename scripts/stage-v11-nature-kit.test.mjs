import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const catalogPath = path.join(root, "apps/web/public/assets/nature-kit/catalog.json");

test("staged V11 catalog contains the audited selection and publishable files", async () => {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  assert.equal(catalog.schema, "deep-engine.v11-nature-kit-catalog");
  assert.equal(catalog.selectedCount, 48);
  assert.equal(catalog.entries.length, 48);
  for (const entry of catalog.entries) {
    assert.match(entry.modelUrl, /^\/assets\/nature-kit\/models\/kenney\.nature-kit\..+\.glb$/);
    assert.equal(entry.thumbnails.length, 4);
    await stat(path.join(root, "apps/web/public", entry.modelUrl.slice(1)));
    for (const thumbnail of entry.thumbnails) await stat(path.join(root, "apps/web/public", thumbnail.slice(1)));
  }
  assert.equal(catalog.entries.filter(entry => entry.groundedDerived).length, 1);
});
