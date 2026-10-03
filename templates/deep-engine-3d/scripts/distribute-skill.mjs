/**
 * H-C7-P2 一份 canonical Skill → 双客户端分发。
 *
 * 规格(docs/specs/ai-first-framework-and-agent-integration-20260930.md §4):
 * canonical SKILL.md 单源维护;仓内官方入口 Codex `.agents/skills/<name>/SKILL.md` 与
 * Claude Code `.claude/skills/<name>/SKILL.md`;安装/分发生成两份相同内容,不手写两套规则。
 * 客户端 MCP 配置不在此生成、不触碰;客户端目录内的无关文件一律保留(用户现有配置)。
 *
 * 用法:node templates/deep-engine-3d/scripts/distribute-skill.mjs [--force] [--root <base>]
 */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(kitRoot, "../..");
const args = process.argv.slice(2);
const force = args.includes("--force");
const rootIndex = args.indexOf("--root");
const baseRoot = rootIndex >= 0 ? resolve(args[rootIndex + 1]) : repoRoot;

const SKILL_NAME = "deep-engine-3d";
const canonicalDir = join(kitRoot, "skill/canonical");
const CLIENT_DIRS = [join(baseRoot, ".agents/skills", SKILL_NAME), join(baseRoot, ".claude/skills", SKILL_NAME)];

async function canonicalFiles() {
  const files = new Map();
  files.set("SKILL.md", await readFile(join(canonicalDir, "SKILL.md")));
  for (const entry of await readdir(join(canonicalDir, "references"))) {
    files.set(join("references", entry), await readFile(join(canonicalDir, "references", entry)));
  }
  // 版本化 references 单源在 kit references/,分发时并入(sdk-versions/templates 清单)。
  for (const json of ["sdk-versions.json", "templates.json"]) {
    files.set(join("references", json), await readFile(join(kitRoot, "references", json)));
  }
  return files;
}

const files = await canonicalFiles();
const result = { schema: 1, skill: SKILL_NAME, baseRoot, force, clients: [] };
for (const clientDir of CLIENT_DIRS) {
  const entry = { dir: clientDir, written: [], kept: [], conflicts: [] };
  await mkdir(join(clientDir, "references"), { recursive: true });
  for (const [relativePath, content] of files) {
    const target = join(clientDir, relativePath);
    let existing;
    try { existing = await readFile(target); } catch { existing = undefined; }
    if (existing === undefined || existing.equals(content)) {
      if (existing === undefined) { await writeFile(target, content); entry.written.push(relativePath); }
      else entry.kept.push(relativePath);
      continue;
    }
    if (!force) {
      entry.conflicts.push(relativePath);
      continue;
    }
    await writeFile(target, content);
    entry.written.push(relativePath);
  }
  // 客户端目录内的其他文件(用户既有配置)一律不动:
  const preserved = (await readdir(clientDir, { recursive: true }))
    .filter(path => !files.has(path.replaceAll("\\", "/")) && path !== "references");
  entry.preservedOthers = preserved;
  assert.deepEqual(entry.conflicts, [], `分发冲突(内容不一致): ${entry.conflicts.join(", ")};` +
    ` 核对后用 --force 覆盖,或不覆盖直接修改 canonical 后重跑`);
  result.clients.push(entry);
}
result.identical = true;
console.log(JSON.stringify(result, null, 2));
