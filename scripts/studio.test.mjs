import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("./studio.mjs", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

test("help and stopped status are read-only through the canonical command", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "deep-monkey-studio-launcher-"));
  const environment = {
    ...process.env,
    BIM_STUDIO_RUNTIME_DIR: join(temporary, "runtime"),
    BIM_STUDIO_LOG_DIR: join(temporary, "logs"),
  };
  try {
    const help = await execFileAsync(process.execPath, [script, "help"], { env: environment, windowsHide: true });
    assert.match(help.stdout, /统一运行入口/);
    assert.match(help.stdout, /start \[client\|web\|api\]/);

    const status = await execFileAsync(process.execPath, [script, "status"], { env: environment, windowsHide: true });
    assert.match(status.stdout, /未运行/);

    await assert.rejects(
      execFileAsync(process.execPath, [script, "check"], { env: environment, windowsHide: true }),
      (error) => error.code === 1 && /未运行/.test(error.stdout),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("user-facing operations guidance only exposes the canonical studio command", async () => {
  const files = [
    "apps/web/src/docs/runtime-and-extensions.md",
    "apps/web/src/docs/deployment-operations.md",
    "apps/web/src/components/NodeRedStudio.tsx",
    "scripts/backup-production.mjs",
    "scripts/restore-production.mjs",
    "https/README.md",
  ];
  const legacyCommand = /pnpm (?:dev:local(?::\w+)?|deploy:cloud(?::\w+)?|dev:all)|bim-studio\.ps1/;

  for (const relativePath of files) {
    const content = await readFile(join(repositoryRoot, relativePath), "utf8");
    assert.doesNotMatch(content, legacyCommand, `${relativePath} 仍暴露旧入口`);
  }

  const backupScript = await readFile(join(repositoryRoot, "scripts/backup-production.mjs"), "utf8");
  const restoreScript = await readFile(join(repositoryRoot, "scripts/restore-production.mjs"), "utf8");
  assert.match(backupScript, /pnpm studio undeploy/);
  assert.match(restoreScript, /pnpm studio undeploy/);
});
