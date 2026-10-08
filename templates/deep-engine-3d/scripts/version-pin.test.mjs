/**
 * H-C7-P2 版本化 references 漂移检测(node --test)。
 * references/sdk-versions.json 是唯一 pin 源;本测试保证 pin 与 SDK 清单一致,
 * deep-engine 升级而未更新 references 时此处红灯并给可执行动作。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(kitRoot, "../..");

test("sdk-versions.json pins match the workspace manifests", async () => {
  const pins = JSON.parse(await readFile(join(kitRoot, "references/sdk-versions.json"), "utf8"));
  const engine = JSON.parse(await readFile(join(repoRoot, "packages/deep-engine/package.json"), "utf8"));
  const declared = { ...engine.dependencies, ...engine.devDependencies };
  assert.equal(pins.engines["@bim-studio/deep-engine"], engine.version,
    `deep-engine 已升级到 ${engine.version}。动作: ${pins.upgradeDetection.onDrift}`);
  assert.equal(pins.engines["@webgpu/types"], declared["@webgpu/types"],
    `@webgpu/types 已变为 ${declared["@webgpu/types"]}。动作: ${pins.upgradeDetection.onDrift}`);
  assert.equal(pins.engines.fflate, engine.dependencies.fflate, "DGC compression must be a pinned runtime dependency");
  assert.equal(pins.pinPolicy.includes("exact"), true, "pin 策略必须是 exact");
});

test("templates catalog matches the kit on disk (8 templates, complete entries)", async () => {
  const catalog = JSON.parse(await readFile(join(kitRoot, "references/templates.json"), "utf8"));
  assert.equal(catalog.templates.length, 8, "H-C7-P2 交付 8 个模板");
  const ids = new Set(catalog.templates.map(entry => entry.id));
  assert.equal(ids.size, 8, "模板 id 不得重复");
  for (const shared of catalog.sharedFiles) {
    await readFile(join(kitRoot, shared)).catch(() => {
      throw new Error(`sharedFiles 清单里的 ${shared} 不存在`);
    });
  }
  for (const template of catalog.templates) {
    for (const file of ["scene.ts", "node.ts", "browser.ts", "index.html",
      "tsconfig.json", "tsconfig.browser.json"]) {
      await readFile(join(kitRoot, "templates", template.id, file)).catch(() => {
        throw new Error(`模板 ${template.id} 缺少 ${file}`);
      });
    }
  }
  const onDisk = (await readdir(join(kitRoot, "templates"), { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.id ?? entry.name).sort();
  assert.deepEqual([...ids].sort(), onDisk, "templates.json 与磁盘目录不一致");
});

test("canonical skill exists and carries the pinned version inside its text", async () => {
  const pins = JSON.parse(await readFile(join(kitRoot, "references/sdk-versions.json"), "utf8"));
  const skill = await readFile(join(kitRoot, "skill/canonical/SKILL.md"), "utf8");
  assert.ok(skill.includes(`"@bim-studio/deep-engine": "${pins.engines["@bim-studio/deep-engine"]}"`),
    "SKILL.md 的安装示例必须使用精确 pin 版本");
  for (const reference of ["references/templates.json", "references/sdk-versions.json",
    "references/api-surface.md", "references/material-parameters.md", "references/run-commands.md"]) {
    assert.ok(skill.includes(reference), `SKILL.md 应引用 ${reference}`);
  }
});

test("installed client skill directories (if present) are in sync with canonical", async () => {
  const canonical = await readFile(join(kitRoot, "skill/canonical/SKILL.md"));
  for (const client of [join(repoRoot, ".agents/skills/deep-engine-3d"),
    join(repoRoot, ".claude/skills/deep-engine-3d")]) {
    const installed = await readFile(join(client, "SKILL.md")).catch(() => null);
    if (installed === null) continue;
    assert.ok(installed.equals(canonical),
      `${client} 落后于 canonical;重跑 node templates/deep-engine-3d/scripts/distribute-skill.mjs`);
  }
});
