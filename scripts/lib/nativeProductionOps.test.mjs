import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { inventoryDirectory, randomSecret, repositoryRoot, runNative, upsertEnvironmentValue } from "./nativeProductionOps.mjs";
import { desktopDevelopmentArguments } from "./localStartupArguments.mjs";

test("inventories backup files deterministically with SHA-256", async () => {
  const directory = path.join(repositoryRoot, "data", "native-ops-test", `${process.pid}-${Date.now()}`);
  await mkdir(path.join(directory, "nested"), { recursive: true });
  try {
    await writeFile(path.join(directory, "b.bin"), Buffer.from([4, 5, 6]));
    await writeFile(path.join(directory, "nested", "a.bin"), Buffer.from([1, 2, 3]));
    const inventory = await inventoryDirectory(directory);
    assert.deepEqual(inventory.map((item) => item.path), ["b.bin", "nested/a.bin"]);
    assert.ok(inventory.every((item) => item.bytes === 3 && /^[A-F0-9]{64}$/.test(item.sha256)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rotates environment values without duplicating keys or exposing weak values", () => {
  const secret = randomSecret(32);
  assert.ok(secret.length >= 40);
  const updated = upsertEnvironmentValue("API_PORT=4100\nBIM_STUDIO_SESSION_SECRET=old\n", "BIM_STUDIO_SESSION_SECRET", secret);
  assert.equal(updated.match(/^BIM_STUDIO_SESSION_SECRET=/gm)?.length, 1);
  assert.match(updated, new RegExp(`BIM_STUDIO_SESSION_SECRET=${secret}`));
  assert.match(upsertEnvironmentValue(updated, "NEW_SECRET", "value"), /NEW_SECRET=value/);
});

test("passes an existing Web dev config to Tauri instead of Cargo", () => {
  const args = desktopDevelopmentArguments(true);
  assert.deepEqual(args, ["--filter", "@bim-studio/desktop", "dev", "--config", "src-tauri/tauri.existing-dev.conf.json"]);
  assert.ok(!args.includes("--"));
  assert.deepEqual(desktopDevelopmentArguments(false), ["--filter", "@bim-studio/desktop", "dev"]);
});

test("redacts sensitive child-process arguments from failures", async () => {
  const secret = "S-sensitive-value";
  await assert.rejects(
    runNative(process.execPath, ["-e", `process.stderr.write('${secret}'); process.exit(2)`], { redact: [secret] }),
    (error) => error instanceof Error && error.message.includes("[REDACTED]") && !error.message.includes(secret),
  );
});
