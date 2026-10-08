import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pruneRuntimePlatforms } from "./prune-runtime-platforms.mjs";

test("deployment retains the complete target payload and package/license while removing other platforms", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-platform-prune-"));
  const pkg = join(root, "node_modules/onnxruntime-node");
  for (const target of ["linux/x64", "linux/arm64", "win32/x64", "darwin/arm64"]) {
    const dir = join(pkg, "bin/napi-v6", target);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "onnxruntime_binding.node"), "binding");
    await writeFile(join(dir, "libonnxruntime.so"), "library");
  }
  await writeFile(join(pkg, "LICENSE"), "MIT");
  const result = await pruneRuntimePlatforms(root, "linux", "x64");
  assert.equal(result.removedBytes, 3 * 14);
  assert.equal(await readFile(join(pkg, "bin/napi-v6/linux/x64/libonnxruntime.so"), "utf8"), "library");
  assert.equal(await readFile(join(pkg, "LICENSE"), "utf8"), "MIT");
  await assert.rejects(stat(join(pkg, "bin/napi-v6/win32")), { code: "ENOENT" });
});

test("missing target binding rejects before deleting another platform", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-platform-missing-"));
  const dir = join(root, "node_modules/onnxruntime-node/bin/napi-v6/win32/x64");
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, "onnxruntime_binding.node"), "binding");
  await assert.rejects(pruneRuntimePlatforms(root, "linux", "x64"));
  assert.ok((await stat(join(dir, "onnxruntime_binding.node"))).isFile());
});
