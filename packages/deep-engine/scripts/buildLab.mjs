import { build } from "esbuild";
import { mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist/lab");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await mkdir(path.join(output, "assets"), { recursive: true });
const result = await build({ absWorkingDir: root, entryPoints: ["lab/main.ts"], bundle: true, format: "esm", target: "es2022", minify: true,
  outfile: path.join(output, "lab.js"), conditions: ["development"], metafile: true, legalComments: "eof" });
const switchResult = await build({ absWorkingDir: root, entryPoints: ["lab/switchMain.ts"], bundle: true, format: "esm", target: "es2022", minify: true,
  outfile: path.join(output, "switch.js"), conditions: ["development"], metafile: true, legalComments: "eof" });
const benchmarkResult = await build({ absWorkingDir: root, entryPoints: ["lab/benchmarkMain.ts"], bundle: true, format: "esm", target: "es2022", minify: true,
  outfile: path.join(output, "benchmark.js"), conditions: ["development"], metafile: true, legalComments: "eof" });
for (const file of ["index.html", "lab.css"]) await copyFile(path.join(root, "lab", file), path.join(output, file));
for (const file of ["switch.html", "switch.css"]) await copyFile(path.join(root, "lab", file), path.join(output, file));
for (const file of ["benchmark.html", "benchmark.css"]) await copyFile(path.join(root, "lab", file), path.join(output, file));
await copyFile(path.resolve(root, "../../apps/web/src/styles/base.css"), path.join(output, "tokens.css"));
for (const file of ["LICENSE", "LICENSE.zh-CN.md", "THIRD_PARTY_NOTICES.md"]) {
  await copyFile(path.resolve(root, "../..", file), path.join(output, file));
}
const artifact = await readFile(path.join(output, "lab.js"));
const assets = {};
const samples = [
  "Box.glb", "BoxInterleaved.glb", "BoxTextured.glb", "NormalTangentTest.glb", "TextureEncodingTest.glb", "TextureTransformMultiTest.glb", "AlphaBlendModeTest.glb",
  "Box.LICENSE.md", "BoxInterleaved.LICENSE.md", "BoxTextured.LICENSE.md", "NormalTangentTest.LICENSE.md", "TextureEncodingTest.LICENSE.md", "TextureTransformMultiTest.LICENSE.md", "AlphaBlendModeTest.LICENSE.md",
  "BoxTextured.upstream-metadata.json", "NormalTangentTest.upstream-metadata.json", "TextureEncodingTest.upstream-metadata.json", "TextureTransformMultiTest.upstream-metadata.json", "AlphaBlendModeTest.upstream-metadata.json", "sources.json",
];
for (const file of samples) await copyFile(path.join(root, "lab/assets", file), path.join(output, "assets", file));
for (const file of ["lab.js", "switch.js", "benchmark.js", "index.html", "lab.css", "switch.html", "switch.css",
  "benchmark.html", "benchmark.css", "tokens.css", "LICENSE", "LICENSE.zh-CN.md", "THIRD_PARTY_NOTICES.md",
  ...samples.map(file => `assets/${file}`)]) {
  assets[file] = createHash("sha256").update(await readFile(path.join(output, file))).digest("hex");
}
const inputs = {};
for (const name of Object.keys(result.metafile.inputs).sort()) {
  inputs[name] = createHash("sha256").update(await readFile(path.resolve(root, name))).digest("hex");
}
const switchInputs = {};
for (const name of Object.keys(switchResult.metafile.inputs).sort()) {
  switchInputs[name] = createHash("sha256").update(await readFile(path.resolve(root, name))).digest("hex");
}
const benchmarkInputs = {};
for (const name of Object.keys(benchmarkResult.metafile.inputs).sort()) {
  benchmarkInputs[name] = createHash("sha256").update(await readFile(path.resolve(root, name))).digest("hex");
}
const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
if (sourceDateEpoch !== undefined && !/^(0|[1-9]\d*)$/.test(sourceDateEpoch)) {
  throw new Error("SOURCE_DATE_EPOCH must be an unsigned integer number of seconds.");
}
const created = sourceDateEpoch === undefined ? undefined : new Date(Number(sourceDateEpoch) * 1_000).toISOString();
const manifest = { schema: 1, ...(created ? { created } : {}), entry: "lab/main.ts", runtimeEngineDependencies: [],
  javascriptBytes: artifact.length, gzipBytes: gzipSync(artifact).length, sha256: createHash("sha256").update(JSON.stringify(assets)).digest("hex"), assets, inputs,
  migrationSwitchLab: { entry: "lab/switchMain.ts", runtimeEngineDependencies: ["three"], inputs: switchInputs },
  competitiveBenchmarkLab: { entry: "lab/benchmarkMain.ts", runtimeEngineDependencies: ["three"], inputs: benchmarkInputs } };
await writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ output, javascriptBytes: manifest.javascriptBytes, gzipBytes: manifest.gzipBytes, sha256: manifest.sha256 }));
