import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_PURITY_ALLOWLIST, scanCargoManifest, scanNativeDependencyTree, scanNativeRuntime, scanPackageManifest, scanTypeScriptRuntime } from "./runtimePurityPolicy.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const nativeRoot = path.resolve(packageRoot, "../deep-engine-native");

async function collect(root, relative, extensions) {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.posix.join(relative.replaceAll("\\", "/"), entry.name);
    if (entry.isDirectory()) result.push(...await collect(root, child, extensions));
    else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      result.push({ file: child, code: await readFile(path.join(root, child), "utf8") });
    }
  }
  return result;
}

const allTypeScript = await collect(packageRoot, "src", [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".html", ".css"]);
const typeScript = allTypeScript.filter(({ file }) => !RUNTIME_PURITY_ALLOWLIST.excludedFileSuffixes.some((suffix) => file.endsWith(suffix)));
const native = [
  ...await collect(nativeRoot, "src", [".rs", ".wgsl"]),
  ...await collect(nativeRoot, "assets/shaders", [".wgsl"]),
];
const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
const cargoManifest = await readFile(path.join(nativeRoot, "Cargo.toml"), "utf8");
let cargoTree;
try {
  cargoTree = execFileSync("cargo", ["tree", "--locked", "--manifest-path", path.join(nativeRoot, "Cargo.toml"), "--target", "x86_64-pc-windows-msvc", "--edges", "normal", "--prefix", "none", "--format", "{p}"], { encoding: "utf8" });
} catch (error) {
  throw new Error(`Native dependency resolution failed; purity cannot be proven. ${error instanceof Error ? error.message : String(error)}`);
}

const issues = [
  ...scanTypeScriptRuntime(typeScript),
  ...scanNativeRuntime(native),
  ...scanPackageManifest(manifest, "package.json"),
  ...scanCargoManifest(cargoManifest),
  ...scanNativeDependencyTree(cargoTree.split(/\r?\n/)),
].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.code.localeCompare(b.code));

if (issues.length) {
  for (const issue of issues) console.error(`${issue.file}:${issue.line}:${issue.column} ${issue.code} ${issue.detail}`);
  throw new Error(`Deep Engine runtime purity failed with ${issues.length} issue(s).`);
}

console.log(`Runtime purity passed: ${typeScript.length} browser/core sources, ${native.length} native sources, ${cargoTree.trim().split(/\r?\n/).length} resolved Windows packages.`);
console.log(`Allowlist: ${JSON.stringify(RUNTIME_PURITY_ALLOWLIST)}`);
