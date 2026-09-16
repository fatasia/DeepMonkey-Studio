import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist/lab");
const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
if (manifest.schema !== 1 || !record(manifest.assets) || !record(manifest.inputs)) {
  throw new Error("Lab artifact manifest is malformed.");
}

const assetNames = Object.keys(manifest.assets);
if (!assetNames.length || new Set(assetNames).size !== assetNames.length) {
  throw new Error("Lab artifact manifest must contain unique assets.");
}
for (const name of assetNames) {
  const file = resolveInside(output, name), bytes = await readFile(file);
  if (sha256(bytes) !== manifest.assets[name]) throw new Error(`Lab artifact hash mismatch: ${name}.`);
}
const files = (await walk(output)).filter(name => name !== "manifest.json").sort();
const declared = [...assetNames].sort();
if (JSON.stringify(files) !== JSON.stringify(declared)) {
  throw new Error("Lab artifact directory and manifest contents differ.");
}
if (sha256(JSON.stringify(manifest.assets)) !== manifest.sha256) {
  throw new Error("Lab aggregate artifact hash is invalid.");
}
const entry = await readFile(resolveInside(output, "lab.js"));
if (manifest.javascriptBytes !== entry.length || manifest.gzipBytes !== gzipSync(entry).length) {
  throw new Error("Lab entry size evidence is invalid.");
}

for (const inputs of [manifest.inputs, manifest.migrationSwitchLab?.inputs,
  manifest.competitiveBenchmarkLab?.inputs]) {
  if (!record(inputs)) throw new Error("Lab entry input manifest is malformed.");
  for (const [name, expected] of Object.entries(inputs)) {
    if (typeof expected !== "string" || sha256(await readFile(path.resolve(root, name))) !== expected) {
      throw new Error(`Lab source input hash mismatch: ${name}.`);
    }
  }
}
console.log(JSON.stringify({ verified: true, files: files.length, sha256: manifest.sha256 }));

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function resolveInside(parent, name) {
  if (typeof name !== "string" || !name || name.includes("\\") || path.isAbsolute(name)) {
    throw new Error(`Invalid Lab artifact path: ${String(name)}.`);
  }
  const resolved = path.resolve(parent, name), relative = path.relative(parent, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Lab artifact path escapes its output: ${name}.`);
  }
  return resolved;
}
async function walk(directory, prefix = "") {
  const outputNames = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) outputNames.push(...await walk(path.join(directory, entry.name), name));
    else if (entry.isFile()) outputNames.push(name);
    else throw new Error(`Lab artifact contains a non-file entry: ${name}.`);
  }
  return outputNames;
}
