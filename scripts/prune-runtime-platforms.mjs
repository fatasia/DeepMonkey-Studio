import assert from "node:assert/strict";
import { realpath, readdir, rm, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

async function bytesUnder(path) {
  const info = await stat(path);
  if (info.isFile()) return info.size;
  const entries = await readdir(path);
  let total = 0;
  for (const entry of entries) total += await bytesUnder(join(path, entry));
  return total;
}

export async function pruneRuntimePlatforms(runtimeRoot, platform, arch) {
  assert.ok(["linux", "win32", "darwin"].includes(platform));
  assert.ok(["x64", "arm64"].includes(arch));
  const root = await realpath(resolve(runtimeRoot));
  const binaryRoot = await realpath(join(root, "node_modules/onnxruntime-node/bin/napi-v6"));
  const relativeRoot = relative(root, binaryRoot);
  assert.ok(relativeRoot && relativeRoot !== ".." && !relativeRoot.startsWith(".." + sep), "ONNX package must be inside the deployed runtime");
  const kept = join(binaryRoot, platform, arch);
  assert.ok((await stat(join(kept, "onnxruntime_binding.node"))).isFile(), "Target binding must exist before pruning");
  const removed = [];
  for (const entry of await readdir(binaryRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== platform) removed.push(join(binaryRoot, entry.name));
    else for (const target of await readdir(join(binaryRoot, entry.name), { withFileTypes: true })) {
      if (target.isDirectory() && target.name !== arch) removed.push(join(binaryRoot, entry.name, target.name));
    }
  }
  let bytes = 0;
  for (const path of removed) {
    const actual = await realpath(path), location = relative(binaryRoot, actual);
    assert.ok(location && location !== ".." && !location.startsWith(".." + sep), "Prune target escaped the ONNX binary tree");
    bytes += await bytesUnder(path);
    await rm(path, { recursive: true });
  }
  return { platform, arch, kept, removed: removed.map(path => relative(root, path)), removedBytes: bytes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, platform = process.platform, arch = process.arch, ...rest] = process.argv.slice(2);
  assert.ok(root && rest.length === 0, "Expected runtimeRoot [platform] [arch]");
  console.log(JSON.stringify(await pruneRuntimePlatforms(root, platform, arch), null, 2));
}
