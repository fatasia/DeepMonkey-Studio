import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { rasterizeNativeText, rasterizeNativeTextBatch } from "./lib/nativeTextRasterizer.mjs";
import { sha256 } from "./lib/nativeTextRasterWire.mjs";

const [priorArg, executableArg, outputArg] = process.argv.slice(2);
assert(priorArg && executableArg && outputArg, "Expected frozen font evidence, executable and output directory");
const prior = path.resolve(priorArg), output = path.resolve(outputArg);
await mkdir(output);
const executable = path.join(output, "deep-engine-native.exe");
await copyFile(path.resolve(executableArg), executable);
const deployment = JSON.parse(await readFile(path.join(prior, "deployment-v2.json"), "utf8"));
const binding = deployment.fontCatalog.fonts.find(font => font.id === "notocjk-400");
const bytes = await readFile(path.join(prior, "isolated-objects", binding.objectKey));
assert.equal(sha256(bytes), binding.sha256);
const font = { sha256: binding.sha256, faceIndex: binding.faceIndex };
const requests = ["总有功功率", "全部", "华东", "华北", "华南", "机组运行表"].map(text => ({
  schema: "deep-engine.text-raster-request", schemaVersion: 1, locale: "zh-CN",
  fonts: [{ ...font, dataBase64: bytes.toString("base64") }], request: { text, font, weight: 400,
    style: "normal", align: "left", verticalAlign: "top", wrap: "none", fontSize: 24, lineHeight: 32,
    width: 320, height: 64, color: [238,242,244,255] } }));
const rounds = [];
for (const round of [1, 2]) {
  const started = performance.now(), singles = [];
  for (const request of requests) singles.push(await rasterizeNativeText({ nativeExecutable: executable, request }));
  const singleMs = performance.now() - started, batchStarted = performance.now();
  const batch = await rasterizeNativeTextBatch({ nativeExecutable: executable, requests });
  const batchMs = performance.now() - batchStarted;
  singles.forEach((single, index) => { assert.deepEqual(batch[index].result, single.result); assert.deepEqual(batch[index].rgba, single.rgba); });
  rounds.push({ round, singleMs, batchMs, requests: requests.length, allPixelsAndReceiptsEqual: true });
  console.log(JSON.stringify(rounds.at(-1)));
}
await writeFile(path.join(output, "evidence.json"), JSON.stringify({
  scope: "CPU text producer same frozen executable and fonts; excludes browser layout and HTTP candidate orchestration",
  executableSha256: sha256(await readFile(executable)), fontSha256: font.sha256, rounds,
}, null, 2));
