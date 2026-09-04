import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withStudioOperationLock } from "./studioOperationLock.mjs";

test("serializes lifecycle mutations across processes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deep-monkey-studio-lock-"));
  const lockFile = join(directory, "runtime", "manager.lock");
  await mkdir(join(directory, "runtime"));
  let releaseFirst;
  const first = withStudioOperationLock(lockFile, () => new Promise((resolve) => { releaseFirst = resolve; }));

  await assert.rejects(withStudioOperationLock(lockFile, async () => undefined), /正在执行/);
  releaseFirst();
  await first;
  await withStudioOperationLock(lockFile, async () => undefined);
  await rm(directory, { recursive: true, force: true });
});

test("recovers a lock whose owner no longer exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deep-monkey-studio-stale-lock-"));
  const lockFile = join(directory, "manager.lock");
  await writeFile(lockFile, `${JSON.stringify({ pid: 2_147_483_647, token: "stale" })}\n`, "utf8");

  await withStudioOperationLock(lockFile, async () => undefined);
  await assert.rejects(async () => (await import("node:fs/promises")).access(lockFile));
  await rm(directory, { recursive: true, force: true });
});
