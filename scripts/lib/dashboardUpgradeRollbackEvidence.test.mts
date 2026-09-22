import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  assertRegionsIdentical,
  atomicReplace,
  checkpointState,
  hashInventory,
  regionDelta,
  type PixelDigest,
} from "./dashboardUpgradeRollbackEvidence.mts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("reads recovery checkpoints and inventories replaced artifacts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dashboard-upgrade-evidence-"));
  try {
    const sourcePath = path.join(directory, "runtime-package.json");
    const checkpointDirectory = path.join(directory, "DeepEngineNative", "package-recovery", "fixture-key");
    const payload = Buffer.from("runtime-package-v2");
    await mkdir(checkpointDirectory, { recursive: true });
    await writeFile(path.join(checkpointDirectory, "active.json"), JSON.stringify({
      version: 1,
      source: path.resolve(sourcePath).toLowerCase(),
      hash: "fixture-hash",
    }));
    await writeFile(path.join(checkpointDirectory, "fixture-hash.json"), payload);

    const checkpoint = await checkpointState(directory, sourcePath);
    assert.equal(checkpoint.key, checkpointDirectory);
    assert.equal(checkpoint.active.hash, "fixture-hash");
    assert.equal(checkpoint.files["fixture-hash.json"], sha(payload));

    await writeFile(sourcePath, "old");
    await atomicReplace(sourcePath, Buffer.from("new"));
    assert.equal(await readFile(sourcePath, "utf8"), "new");
    const inventory = await hashInventory(directory);
    assert.deepEqual(inventory.map(entry => entry.file), [...inventory.map(entry => entry.file)].sort());
    assert(inventory.some(entry => entry.file === "runtime-package.json" && entry.sha256 === sha(Buffer.from("new"))));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("compares stable pixel regions and reports average RGB delta", () => {
  const left: PixelDigest = { width: 2, height: 2, full: "same", regions: {
    banner: { sha256: "banner", rgb: [10, 20, 30] },
  } };
  const right: PixelDigest = { width: 2, height: 2, full: "same", regions: {
    banner: { sha256: "banner", rgb: [13, 17, 36] },
  } };
  assertRegionsIdentical(left, right, "fixture");
  assert.equal(regionDelta(left, right, "banner"), 4);
  assert.throws(() => assertRegionsIdentical(left, { ...right, full: "different" }, "fixture"), /full-window/);
});
