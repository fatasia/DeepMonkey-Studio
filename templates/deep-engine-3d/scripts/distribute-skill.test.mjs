/**
 * H-C7-P2 双客户端分发机制测试(node --test):全部在临时目录进行,不触碰仓内客户端目录。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function runDistributor(baseRoot, extra = []) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)(process.execPath,
    [join(kitRoot, "scripts/distribute-skill.mjs"), "--root", baseRoot, ...extra],
    { encoding: "utf8", timeout: 60_000 });
  return JSON.parse(stdout);
}

test("distributor installs byte-identical skill into both client directories", async () => {
  const base = await mkdtemp(join(tmpdir(), "hc7p2-skill-"));
  const result = await runDistributor(base);
  assert.equal(result.identical, true);
  assert.equal(result.clients.length, 2);
  const canonical = await readFile(join(kitRoot, "skill/canonical/SKILL.md"));
  for (const client of result.clients) {
    const installed = await readFile(join(client.dir, "SKILL.md"));
    assert.ok(installed.equals(canonical), `${client.dir} 内容必须与 canonical 一致`);
    for (const reference of ["sdk-versions.json", "templates.json", "api-surface.md",
      "material-parameters.md", "run-commands.md"]) {
      await readFile(join(client.dir, "references", reference));
    }
  }
  const [codex, claude] = result.clients;
  assert.ok(codex.dir.includes(".agents"), "Codex 入口 .agents/skills");
  assert.ok(claude.dir.includes(".claude"), "Claude 入口 .claude/skills");
});

test("distributor is idempotent and preserves unrelated client files", async () => {
  const base = await mkdtemp(join(tmpdir(), "hc7p2-skill-"));
  await runDistributor(base);
  const unrelated = join(base, ".claude/skills/deep-engine-3d", "user-notes.md");
  await writeFile(unrelated, "user content");
  const second = await runDistributor(base);
  const claude = second.clients.find(client => client.dir.includes(".claude"));
  assert.ok(claude.kept.includes("SKILL.md"), "重跑不重写未变化文件(kept)");
  assert.equal(await readFile(unrelated, "utf8"), "user content", "客户端目录内无关文件不得被动");
});

test("distributor refuses conflicting client files without --force and succeeds with it", async () => {
  const base = await mkdtemp(join(tmpdir(), "hc7p2-skill-"));
  await runDistributor(base);
  await writeFile(join(base, ".agents/skills/deep-engine-3d", "SKILL.md"), "drifted");
  await assert.rejects(() => runDistributor(base), /--force/);
  await runDistributor(base, ["--force"]);
  const canonical = await readFile(join(kitRoot, "skill/canonical/SKILL.md"));
  assert.ok((await readFile(join(base, ".agents/skills/deep-engine-3d/SKILL.md"))).equals(canonical));
});

test("verify-distribution passes on a fresh install and detects drift", async () => {
  const base = await mkdtemp(join(tmpdir(), "hc7p2-skill-"));
  await runDistributor(base);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = args => promisify(execFile)(process.execPath,
    [join(kitRoot, "scripts/verify-distribution.mjs"), "--root", base, ...args],
    { encoding: "utf8", timeout: 60_000, cwd: kitRoot });
  const verdict = JSON.parse((await run([])).stdout);
  assert.equal(verdict.status, "passed");
  assert.ok(verdict.verifiedExports.length >= 10, "发布门必须核对示例实际导出");
  await writeFile(join(base, ".claude/skills/deep-engine-3d", "SKILL.md"), "stale");
  await assert.rejects(() => run([]), /不一致|distribute/);
});
