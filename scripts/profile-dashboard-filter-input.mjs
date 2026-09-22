import assert from "node:assert/strict";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { captureNativePlayerWindow } from "./lib/dashboardNativeWindowCapture.mjs";
const [packageArg, exeArg, outputArg] = process.argv.slice(2);
assert(packageArg && exeArg && outputArg);
const output = path.resolve(outputArg); await mkdir(output);
const executable = path.join(output, "deep-engine-native.exe"), packagePath = path.join(output, "runtime-package.json");
await copyFile(path.resolve(exeArg), executable); await copyFile(path.resolve(packageArg), packagePath);
const captures = [];
for (const option of [1, 2]) {
  const result = await captureNativePlayerWindow({ label: `option-${option}`, executable,
    args: ["--package", packagePath], outputDirectory: output, clientSize: [960,540], clientClick: [60,292 + option * 63],
    env: { ...process.env, LOCALAPPDATA: path.join(output, "local-app-data"), DEEP_DASHBOARD_FILTER_EVIDENCE: "1" },
    presentedMarker: "native Deep2d", timeoutMs: 60000 });
  const timings = [...result.playerLogTail.matchAll(/selected=Some\((\d+)\).*update_ms=([\d.]+) action_ms=([\d.]+) stage_ms=([\d.]+)/g)]
    .map(match => ({ selected: Number(match[1]), totalMs: Number(match[2]), actionMs: Number(match[3]), stageMs: Number(match[4]) }));
  assert.equal(timings.at(-1)?.selected, option);
  captures.push({ ...result, timings }); console.log(JSON.stringify({ option, timings }));
}
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
await writeFile(path.join(output, "evidence.json"), JSON.stringify({
  scope: "handler to successful present; does not include OS input queue latency", captures,
  executableSha256: hash(await readFile(executable)), packageSha256: hash(await readFile(packagePath)),
}, null, 2));
