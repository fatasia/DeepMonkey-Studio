import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

test("asset pack import validates manifest and installs a catalog atomically", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bim-asset-pack-"));
  const pack = path.join(dir, "pack"); const target = path.join(dir, "library");
  await mkdir(pack, { recursive: true });
  const model = Buffer.from("model"); await writeFile(path.join(pack, "model.glb"), model);
  await writeFile(path.join(pack, "catalog.json"), JSON.stringify({ models: [], files: [] }));
  await writeFile(path.join(pack, "audit.json"), JSON.stringify({ items: [] }));
  const sha256 = createHash("sha256").update(model).digest("hex");
  await writeFile(path.join(pack, "pack.manifest.json"), JSON.stringify({ schemaVersion: 1, id: "test", version: "1.0.0", publicationStatus: "published", license: "CC0-1.0", files: [{ path: "model.glb", sha256 }] }));
  const result = await run([pack, `--target=${target}`]);
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /开放素材包已导入/);
  await rm(dir, { recursive: true, force: true });
});

async function run(arguments_) { return await new Promise((resolve) => { const child = spawn(process.execPath, ["scripts/import-open-asset-pack.mjs", ...arguments_], { cwd: path.resolve(import.meta.dirname, "..") }); let stdout = "", stderr = ""; child.stdout.on("data", (c) => stdout += c); child.stderr.on("data", (c) => stderr += c); child.on("close", (code) => resolve({ code, stdout, stderr })); }); }
