import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { repositoryRoot } from "./lib/nativeProductionOps.mjs";

test("rotates a staged environment atomically without printing secret values", async () => {
  const directory = path.join(repositoryRoot, "data", "rotate-secrets-test", `${process.pid}-${Date.now()}`);
  const environmentPath = path.join(directory, ".env");
  const recoveryPath = path.join(directory, "recovery.env");
  await mkdir(directory, { recursive: true });
  await writeFile(environmentPath, "API_PORT=4100\nBIM_STUDIO_ADMIN_PASSWORD=old-admin-value\nBIM_STUDIO_SESSION_SECRET=old-session-value\n", "utf8");
  try {
    const result = spawnSync(process.execPath, [
      path.join(repositoryRoot, "scripts", "rotate-production-secrets.mjs"),
      "--confirm", "ROTATE-APPLICATION-SECRETS",
      "--env-file", environmentPath,
      "--recovery-file", recoveryPath,
    ], { cwd: repositoryRoot, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const rotated = await readFile(environmentPath, "utf8");
    const recovery = await readFile(recoveryPath, "utf8");
    const admin = rotated.match(/^BIM_STUDIO_ADMIN_PASSWORD=(.+)$/m)?.[1];
    const session = rotated.match(/^BIM_STUDIO_SESSION_SECRET=(.+)$/m)?.[1];
    assert.ok(admin && admin !== "old-admin-value" && admin.length >= 30);
    assert.ok(session && session !== "old-session-value" && session.length >= 60);
    assert.match(recovery, new RegExp(`BIM_STUDIO_ADMIN_PASSWORD=${admin}`));
    assert.ok(!result.stdout.includes(admin) && !result.stdout.includes(session));
    assert.equal(await readFile(`${environmentPath}.previous`, "utf8"), "API_PORT=4100\nBIM_STUDIO_ADMIN_PASSWORD=old-admin-value\nBIM_STUDIO_SESSION_SECRET=old-session-value\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
