import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  existingPackageFiles,
  findBrokenLocalLinks,
  isForbiddenTrackedPath,
  isValidLargeFileException,
  isValidPullRequestTitle,
} from "./check-repository-governance.mjs";

test("ignores package manifests deleted from the working tree", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "repository-governance-packages-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), "{}");
  assert.deepEqual(existingPackageFiles(root, ["package.json", "apps/removed/package.json"]), ["package.json"]);
});

test("requires explicit reasons and content hashes for large-file exceptions", () => {
  assert.equal(isValidLargeFileException({
    path: "models/example.onnx",
    reason: "Required offline runtime model artifact.",
    sha256: "a".repeat(64),
  }), true);
  assert.equal(isValidLargeFileException({ path: "models\\example.onnx", reason: "too short", sha256: "no" }), false);
});

test("blocks local, generated, credential, and private-key paths without blocking examples", () => {
  for (const path of [".env", "apps/api/.env.production", "certs/server.key", "dist/app.js", "test-output/report.json", "login-verification.png"]) {
    assert.equal(isForbiddenTrackedPath(path), true, path);
  }
  for (const path of [".env.example", "apps/api/src/data.ts", "docs/build-guide.md", "src/targetState.ts"]) {
    assert.equal(isForbiddenTrackedPath(path), false, path);
  }
});

test("validates scoped Conventional Commit Pull Request titles", () => {
  for (const title of ["feat: add asset audit", "fix(viewer): release textures", "docs!: revise public contract"]) {
    assert.equal(isValidPullRequestTitle(title), true, title);
  }
  for (const title of ["Update files", "feature: add audit", "fix: x"]) {
    assert.equal(isValidPullRequestTitle(title), false, title);
  }
});

test("checks relative Markdown links from the document directory", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "repository-governance-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "target.md"), "ok");
  const content = "[valid](../target.md#section) [remote](https://example.com) [missing](missing.md)";
  assert.deepEqual(findBrokenLocalLinks(root, "docs/source.md", content), ["missing.md"]);
});
