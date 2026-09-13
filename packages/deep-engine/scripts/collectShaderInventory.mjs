import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanShaderUsage } from "./shaderUsageScanner.mjs";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const output = process.argv[2];
if (!output) throw new Error("Usage: node scripts/collectShaderInventory.mjs <output.json>");
const ignored = new Set(["node_modules", "dist", "build", "test-output", ".git", "assets", "models", "public"]);
const accepted = /\.(?:[cm]?[jt]sx?|wgsl|glsl|vert|frag)$/i;
const files = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile() && accepted.test(entry.name)) files.push(path);
  }
}
await collect(join(workspace, "apps"));
await collect(join(workspace, "packages"));
const sources = [], manifest = [];
for (const file of files.sort()) {
  if (file.includes(join("packages", "deep-engine"))) continue;
  const code = await readFile(file, "utf8"), relativeFile = relative(workspace, file).replaceAll("\\", "/");
  manifest.push({ file: relativeFile, sha256: createHash("sha256").update(code).digest("hex") });
  sources.push({ file: relativeFile, code });
}
const scan = scanShaderUsage(sources), byKind = {};
for (const item of scan.evidence) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
const report = {
  schemaVersion: 1,
  status: "static-source-inventory-only",
  corpusHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
  scope: ["apps static code", "packages static code", "includes tests", "excludes Deep Engine implementation"],
  missingEvidence: ["persisted project scripts", "published application scripts", "runtime shader mutation",
    "generated shader strings", "asset/model/public shader files", "Unity ShaderLab and Shader Graph assets", "visual and runtime parity"],
  counts: { files: manifest.length, evidence: scan.evidence.length, unresolved: scan.unresolved.length, byKind },
  ...scan,
  manifest,
};
const target = resolve(workspace, output);
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output: target, ...report.counts, corpusHash: report.corpusHash }));
