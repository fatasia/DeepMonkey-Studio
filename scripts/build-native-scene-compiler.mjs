import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const requireApi = createRequire(path.join(root, "apps/api/package.json"));
const { build } = requireApi("esbuild");
const [flag, output, ...rest] = process.argv.slice(2);
if (flag !== undefined && (flag !== "--output" || !output || rest.length)) throw new Error("Expected --output <build directory>");
const directory = output ? path.resolve(output) : path.join(root, "apps/api/dist/native-scene-compiler");
const manifestFile = path.join(directory, "manifest.json");
const compilerFile = path.join(directory, "compiler.mjs");
const windowFile = path.join(directory, "window-verifier.mjs");
const BUILD_VERSION = 2;

async function canReuseBundle() {
  try {
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    if (manifest.schemaVersion !== 1 || manifest.buildVersion !== BUILD_VERSION
      || !Array.isArray(manifest.inputs) || !manifest.compilerSha256 || !manifest.windowVerifierSha256) return false;
    await Promise.all([access(compilerFile), access(windowFile)]);
    const current = await Promise.all(manifest.inputs.map(async (entry) => ({
      path: entry.path,
      sha256: hash(await readFile(path.resolve(root, entry.path))),
    })));
    return JSON.stringify(current) === JSON.stringify(manifest.inputs);
  } catch {
    return false;
  }
}

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
if (await canReuseBundle()) {
  console.log("Native scene compiler bundle unchanged; reusing existing build");
  process.exit(0);
}
await mkdir(directory, { recursive: true });
const outfile = compilerFile;
const result = await build({ absWorkingDir: root, entryPoints: ["scripts/native-scene-compiler-worker.mjs"],
  outfile, bundle: true, platform: "node", format: "esm", conditions: ["development"],
  external: ["sharp", "@gltf-transform/core", "@gltf-transform/extensions", "draco3dgltf"], metafile: true, logLevel: "error" });
const windowBuild = await build({ absWorkingDir: root, entryPoints: ["scripts/native-scene-window-verifier.mjs"], outfile: windowFile,
  bundle: true, platform: "node", format: "esm", conditions: ["development"], metafile: true, logLevel: "error" });
const inputs = await Promise.all([...new Set([...Object.keys(result.metafile.inputs), ...Object.keys(windowBuild.metafile.inputs)])].sort().map(async file => ({
  path: file.replaceAll("\\", "/"), sha256: hash(await readFile(path.resolve(root, file))),
})));
await writeFile(manifestFile, JSON.stringify({ schemaVersion: 1, buildVersion: BUILD_VERSION,
  compilerSha256: hash(await readFile(outfile)), windowVerifierSha256: hash(await readFile(windowFile)), inputs }, null, 2));
console.log("Native scene compiler bundle built");
