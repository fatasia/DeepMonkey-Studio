import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveFixture } from "./lib/sceneClientArchiveFixture.mjs";

const run = promisify(execFile), cli = fileURLToPath(new URL("./verify-scene-client-package.mjs", import.meta.url));
test("CLI verifies bytes and exits nonzero for mismatch, damage, and missing input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scene-client-cli-"));
  try {
    const path = join(directory, "场景.bimscene.zip"), fixture = await archiveFixture();
    await writeFile(path, fixture.buffer);
    const result = await run(process.execPath, [cli, path, "--target", "three-webview"]);
    assert.deepEqual(JSON.parse(result.stdout), { status: "integrity-verified", target: "three-webview",
      contentHash: fixture.manifest.contentHash.value, fileCount: 5,
      totalBytes: fixture.manifest.files.reduce((n, file) => n + file.bytes, 0) + Buffer.byteLength(JSON.stringify(fixture.manifest)) });
    await assert.rejects(run(process.execPath, [cli, path, "--target", "deep-native"]), error => error.code === 1 && /expectedTarget/.test(error.stderr));
    await writeFile(path, Buffer.from("broken ZIP"));
    await assert.rejects(run(process.execPath, [cli, path, "--target", "three-webview"]), error => error.code === 1);
    await assert.rejects(run(process.execPath, [cli]), error => error.code === 1 && /用法/.test(error.stderr));
    await assert.rejects(run(process.execPath, [cli, join(directory, "missing"), "--target", "three-webview"]), error => error.code === 1 && /ENOENT/.test(error.stderr));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
