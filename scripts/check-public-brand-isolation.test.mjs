import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const gatePath = fileURLToPath(new URL("./check-public-brand-isolation.mjs", import.meta.url));

test("品牌门禁会扫描 TypeScript 与 TSX 中的禁止品牌", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bim-studio-brand-gate-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const prohibitedProduct = ["i", "Twin"].join("");
  const prohibitedVendor = ["Bent", "ley"].join("");
  await writeFile(join(directory, "branding.ts"), `export const product = "${prohibitedProduct} Studio";\n`);
  await writeFile(join(directory, "vendor.tsx"), `export const vendor = <span>${prohibitedVendor}</span>;\n`);

  const result = runGate(directory);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /branding\.ts/);
  assert.match(result.stderr, /vendor\.tsx/);
  assert.match(result.stderr, new RegExp(prohibitedProduct, "i"));
  assert.match(result.stderr, new RegExp(prohibitedVendor, "i"));
});

test("品牌门禁允许中性自有品牌源码", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bim-studio-brand-gate-safe-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "branding.tsx"), "export const title = <strong>Deep Monkey Studio</strong>;\n");

  const result = runGate(directory);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /门禁通过/);
});

test("品牌门禁拒绝已停用的旧产品名", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bim-studio-retired-brand-gate-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const retiredName = ["Industrial", "Studio"].join(" ");
  await writeFile(join(directory, "legacy-title.html"), `<title>${retiredName}</title>\n`);

  const result = runGate(directory);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /legacy-title\.html/);
  assert.match(result.stderr, new RegExp(["industrial", "studio"].join(" "), "i"));
});

function runGate(directory) {
  return spawnSync(process.execPath, [gatePath, directory], { encoding: "utf8" });
}
