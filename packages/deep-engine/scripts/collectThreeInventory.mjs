import { createHash } from "node:crypto";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanThreeUsage } from "./threeUsageScanner.mjs";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const output = process.argv[2];
if (!output) throw new Error("Usage: node scripts/collectThreeInventory.mjs <output.json>");
const files = [];
const ignored = new Set(["node_modules", "dist", "build", "test-output", ".git", "assets", "models", "public"]);
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name)) files.push(path);
  }
}
await collect(join(workspace, "apps"));
await collect(join(workspace, "packages"));
const sources = [];
const manifest = [];
for (const file of files.sort()) {
  if (file.includes(`${join("packages", "deep-engine")}`)) continue;
  const code = await readFile(file, "utf8");
  const relativeFile = relative(workspace, file).replaceAll("\\", "/");
  const hash = createHash("sha256").update(code).digest("hex");
  manifest.push({ file: relativeFile, sha256: hash });
  // 全文件进入 AST 绑定，避免同名局部参数/类型被误计入 Three API。
  sources.push({ file: relativeFile, code });
}
const inventory = scanThreeUsage(sources);
const symbols = new Map();
for (const usage of inventory.usages) {
  const key = `${usage.module}:${usage.symbol}`;
  const item = symbols.get(key) ?? { module: usage.module, symbol: usage.symbol, valueUses: 0, typeUses: 0, files: new Set() };
  item[usage.kind === "value" ? "valueUses" : "typeUses"]++;
  item.files.add(usage.file);
  symbols.set(key, item);
}
const report = {
  schemaVersion: 1,
  status: "source-inventory-only",
  threeVersion: JSON.parse(await readFile(join(workspace, "apps/web/package.json"), "utf8")).dependencies.three,
  corpusHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
  scope: ["apps static source", "packages static source", "includes tests and declaration files"],
  missingEvidence: ["persisted project scripts", "published application scripts", "Markdown examples", "AI script evaluations", "dynamic imports and namespace escapes", "instance member semantics", "runtime trace parity", "visual parity"],
  counts: { files: manifest.length, symbols: symbols.size, usages: inventory.usages.length, unresolved: inventory.unresolved.length },
  symbols: [...symbols.values()].sort((a, b) => `${a.module}:${a.symbol}`.localeCompare(`${b.module}:${b.symbol}`, "en"))
    .map((item) => ({ ...item, files: [...item.files].sort(), compatibility: "unverified" })),
  ...inventory,
  manifest,
};
const target = resolve(workspace, output);
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output: target, ...report.counts, corpusHash: report.corpusHash }));
