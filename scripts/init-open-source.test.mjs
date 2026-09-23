import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

test("one-command init installs only public system metadata and a reusable showcase", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bim-studio-init-"));
  try {
    const arguments_ = ["scripts/init-open-source.mjs", `--data-dir=${directory}`, "--prepare-only"];
    await execFileAsync(process.execPath, arguments_, { cwd: root, env: { ...process.env, METADATA_STORE: "json" } });
    const target = path.join(directory, "database.json");
    const original = await readFile(target, "utf8");
    const document = JSON.parse(original);
    assert.equal(document.projects.length, 1);
    assert.equal(document.projects[0].id, "default");
    assert.equal(document.projects[0].models.length, 0);
    assert.equal(document.scenes.length, 4);
    assert.equal(document.applications.length, 1);
    assert.equal(document.applications[0].pages.length, 4);
    assert.equal(document.publishedScenes.length, 0);
    assert.equal(document.users.length, 0);
    await execFileAsync(process.execPath, arguments_, { cwd: root, env: { ...process.env, METADATA_STORE: "json" } });
    assert.equal(await readFile(target, "utf8"), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("one-command init supports SQLite metadata", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bim-studio-init-sqlite-"));
  try {
    const sqlitePath = path.join(directory, "metadata.sqlite");
    await execFileAsync(process.execPath, ["scripts/init-open-source.mjs", "--prepare-only", `--data-dir=${directory}`], {
      cwd: root,
      env: { ...process.env, METADATA_STORE: "sqlite", SQLITE_DATABASE: sqlitePath },
    });
    const { stat } = await import("node:fs/promises");
    expectFile(await stat(sqlitePath).then(() => true));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function expectFile(value) {
  assert.equal(value, true);
}
