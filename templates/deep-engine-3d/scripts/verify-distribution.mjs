/**
 * H-C7-P2 双客户端分发校验:双端已安装、字节一致、frontmatter 合法、
 * 引用文件与命令真实存在、示例 import 的导出名在 SDK dist 声明中真实存在。
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(kitRoot, "../..");
const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
const baseRoot = rootIndex >= 0 ? resolve(args[rootIndex + 1]) : repoRoot;
const SKILL_NAME = "deep-engine-3d";
const canonicalDir = join(kitRoot, "skill/canonical");
const clients = [join(baseRoot, ".agents/skills", SKILL_NAME), join(baseRoot, ".claude/skills", SKILL_NAME)];

const canonicalFiles = new Map([["SKILL.md", await readFile(join(canonicalDir, "SKILL.md"))]]);
for (const entry of await readdir(join(canonicalDir, "references"))) {
  canonicalFiles.set(join("references", entry), await readFile(join(canonicalDir, "references", entry)));
}
for (const json of ["sdk-versions.json", "templates.json"]) {
  canonicalFiles.set(join("references", json), await readFile(join(kitRoot, "references", json)));
}

function sha256(content) { return createHash("sha256").update(content).digest("hex"); }

const hashes = [];
for (const client of clients) {
  for (const [relativePath, content] of canonicalFiles) {
    const installed = await readFile(join(client, relativePath))
      .catch(() => { throw new Error(`${client} 缺少 ${relativePath};先跑 distribute-skill.mjs`); });
    assert.ok(installed.equals(content), `${join(client, relativePath)} 与 canonical 不一致;重跑 distribute-skill.mjs`);
  }
  hashes.push(sha256(canonicalFiles.get("SKILL.md")));
}
assert.equal(hashes[0], hashes[1], "两个客户端的 SKILL.md 必须字节一致");

const skill = canonicalFiles.get("SKILL.md").toString("utf8");
const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skill);
assert.ok(frontmatter, "SKILL.md 缺少 frontmatter");
assert.match(frontmatter[1], /^name: deep-engine-3d$/m, "frontmatter 需要 name: deep-engine-3d");
assert.match(frontmatter[1], /^description: .+/m, "frontmatter 需要 description");

for (const match of skill.matchAll(/references\/([a-z-]+\.(?:md|json))/g)) {
  assert.ok(canonicalFiles.has(join("references", match[1])),
    `SKILL.md 引用了不存在的 references/${match[1]}`);
}
for (const match of skill.matchAll(/templates\/deep-engine-3d\/(scripts\/[\w-]+\.mjs)/g)) {
  await readFile(join(repoRoot, "templates/deep-engine-3d", match[1]))
    .catch(() => { throw new Error(`SKILL.md 引用的脚本不存在: ${match[1]}`); });
}

// 发布门:示例代码 import 的具名导出必须在 SDK dist d.ts 里真实声明(防照文档调用不存在的函数)。
// 入口 d.ts 会 `export * from "./x.js"` 转发(如 r12/frameCapture),做一级解析后合并声明文本。
async function declarationText(entry) {
  const dir = dirname(join(repoRoot, "packages/deep-engine/dist", entry));
  let text = await readFile(join(repoRoot, "packages/deep-engine/dist", entry), "utf8");
  for (const match of text.matchAll(/^export \* from "\.\/(.+)\.js";?$/gm)) {
    text += `\n` + await readFile(join(dir, `${match[1]}.d.ts`), "utf8")
      .catch(() => readFile(join(dir, match[1], "index.d.ts"), "utf8"));
  }
  return text;
}
const distDeclarations = new Map();
for (const module of ["index.d.ts", "app/index.d.ts", "webgpu/index.d.ts"]) {
  distDeclarations.set(module, await declarationText(module));
}
const templateSources = [];
for (const shared of ["sceneTypes.ts", "harness.ts", "nodeHarness.ts"]) {
  templateSources.push(await readFile(join(kitRoot, shared), "utf8"));
}
const catalog = JSON.parse(await readFile(join(kitRoot, "references/templates.json"), "utf8"));
for (const template of catalog.templates) {
  for (const file of ["scene.ts", "node.ts", "browser.ts"]) {
    templateSources.push(await readFile(join(kitRoot, "templates", template.id, file), "utf8"));
  }
}
const declaredText = [...distDeclarations.values()].join("\n");
const checked = [];
for (const source of templateSources) {
  for (const match of source.matchAll(/import\s*(?:type\s*)?{([^}]*)}\s*from\s*"(@bim-studio\/deep-engine[^"]*)"/g)) {
    const module = match[2];
    const target = module === "@bim-studio/deep-engine" ? "index.d.ts"
      : module === "@bim-studio/deep-engine/app" ? "app/index.d.ts"
      : module === "@bim-studio/deep-engine/webgpu" ? "webgpu/index.d.ts" : undefined;
    assert.ok(target, `示例引用了未登记的 SDK 入口 ${module}`);
    for (const raw of match[1].split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
      if (!name) continue;
      assert.ok(distDeclarations.get(target).includes(name),
        `示例导出 ${name}(${module}) 不在 dist/${target} 声明中;删除示例或先在 SDK 落地`);
      checked.push(`${module}:${name}`);
    }
  }
}

console.log(JSON.stringify({ schema: 1, status: "passed", skill: SKILL_NAME,
  clients, skilLSha256: hashes[0], files: [...canonicalFiles.keys()],
  verifiedExports: [...new Set(checked)].sort(), exportedCount: new Set(checked).size }, null, 2));
