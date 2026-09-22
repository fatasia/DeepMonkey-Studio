import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { captureNativePlayerWindow } from "./lib/dashboardNativeWindowCapture.mjs";

const [packageArg, outputArg] = process.argv.slice(2);
assert(packageArg && outputArg, "Expected package and output directory");
const output = path.resolve(outputArg), packagePath = path.resolve(packageArg);
await mkdir(output);
const frozen = path.join(path.dirname(packagePath), "deep-engine-native.exe");
const executable = await stat(frozen).then(value => value.isFile() ? frozen : undefined).catch(() => undefined)
  ?? path.resolve("packages/deep-engine-native/target/debug/deep-engine-native.exe");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const executableSha256 = hash(await readFile(executable)), captures = [];
for (const round of [1, 2]) for (const state of ["hover", "keyboard", "narrow"] as const) {
  assert.equal(hash(await readFile(executable)), executableSha256);
  const narrow = state === "narrow", scale = narrow ? 0.5 : 1;
  const capture = await captureNativePlayerWindow({ label: `round-${round}-${state}`, executable,
    args: ["--package", packagePath], outputDirectory: output,
    clientSize: narrow ? [480, 480] : [960, 540],
    clientClick: [Math.round(60 * scale), Math.round(355 * scale + (narrow ? 105 : 0))],
    hoverOnly: state !== "narrow", arrowDown: state === "keyboard",
    env: { ...process.env, LOCALAPPDATA: path.join(output, "local-app-data"), DEEP_DASHBOARD_FILTER_EVIDENCE: "1" },
    presentedMarker: "native Deep2d", timeoutMs: 60_000 });
  const selected = state === "hover" ? 0 : 1;
  const last = [...(capture.playerLogTail ?? "").matchAll(/selected=Some\((\d+)\)/g)].at(-1)?.[1];
  assert.equal(last, String(selected), capture.playerLogTail);
  captures.push(capture);
  await writeFile(path.join(output, "evidence.json"), JSON.stringify({ executableSha256,
    packageSha256: hash(await readFile(packagePath)), captures }, null, 2));
}
console.log(`Filter hover/keyboard/narrow states passed: ${captures.length}/6`);
