import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

test("open-source database seed installs reproducible, secret-free metadata", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bim-studio-seed-"));
  try {
    const { stdout } = await execFileAsync(process.execPath, ["scripts/seed-open-database.mjs", `--data-dir=${directory}`], { cwd: root });
    assert.match(stdout, /open-source database seed installed/);
    const document = JSON.parse(await readFile(path.join(directory, "database.json"), "utf8"));
    assert.equal(document.projects[0].id, "default");
    assert.equal(document.projects[0].models.length, 0);
    assert.ok(document.projects[0].dataConnections.length >= 2);
    assert.equal(JSON.stringify(document).includes("password\":\""), false);
    await assert.rejects(() => execFileAsync(process.execPath, ["scripts/seed-open-database.mjs", `--data-dir=${directory}`], { cwd: root }), /database already exists/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
