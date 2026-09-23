import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

test("clean-clone asset delivery gate passes and reports optional external libraries", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["scripts/verify-open-asset-delivery.mjs"], { cwd: root });
  assert.match(stdout, /open asset delivery: passed/);
  assert.match(stdout, /READY nature-kit/);
  assert.match(stdout, /OPTIONAL industrial-source-a/);
  assert.match(stdout, /OPTIONAL external-open-packs/);
  const { stdout: manifestOutput } = await execFileAsync(process.execPath, ["scripts/verify-open-asset-delivery.mjs", "--write=test-output/open-asset-delivery-test-manifest.json"], { cwd: root });
  assert.match(manifestOutput, /asset delivery manifest written/);
  const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(root, "test-output/open-asset-delivery-test-manifest.json"), "utf8"));
  assert.ok(manifest.repository.trackedAssets.files > 0);
  assert.ok(manifest.repository.trackedAssets.byExtension[".glb"].files >= 55);
  assert.equal(manifest.startupContract.automaticNetworkSync, false);
  assert.match(manifest.startupContract.assetLibraryLoad, /首次 GET \/api\/asset-library/);
  assert.ok(manifest.optional.every((item) => item.gitTrackedFiles === 0));
});
