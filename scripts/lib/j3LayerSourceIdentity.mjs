import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { snapshotWindowRecoverySources } from "../j3-window-recovery-suite.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const hash = value => createHash("sha256").update(value).digest("hex");

/** Existing full production snapshot plus the exact layer observers and fixtures. */
export async function snapshotLayerSources(files) {
  const product = await snapshotWindowRecoverySources();
  const extra = Object.fromEntries(await Promise.all([...new Set([
    "scripts/lib/j3LayerSourceIdentity.mjs", ...files,
  ])].map(async file => [file, hash(await readFile(path.join(root, file)))])));
  const sources = Object.fromEntries(Object.entries({ ...product.sources, ...extra })
    .sort(([a], [b]) => a.localeCompare(b)));
  return { sha256: hash(JSON.stringify(sources)), sources };
}

export function requireUnchangedLayerSources(recorded, current) {
  assert(recorded?.sha256 && recorded?.sources, "Stored layer receipt lacks production source identity; run both hosts fresh");
  assert.deepEqual(recorded, current, "Production/observer sources changed; run both hosts fresh");
}
