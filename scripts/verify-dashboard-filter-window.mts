import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { captureNativePlayerWindow } from "./lib/dashboardNativeWindowCapture.mjs";

const [packageArg, outputArg] = process.argv.slice(2);
assert(packageArg && outputArg, "Expected production package and new evidence directory");
const packagePath = path.resolve(packageArg), output = path.resolve(outputArg);
const frozen = path.join(path.dirname(packagePath), "deep-engine-native.exe");
const executable = await stat(frozen).then(value => value.isFile() ? frozen : undefined).catch(() => undefined)
  ?? path.resolve("packages/deep-engine-native/target/debug/deep-engine-native.exe");
await mkdir(output);
const bytes = await readFile(packagePath), envelope = JSON.parse(bytes.toString("utf8"));
const document = envelope.payloads[envelope.entrypoints.dashboard];
assert.deepEqual(document.filter.options.map((option: any) => option.value), ["全部", "华东", "华北", "华南"]);
assert.deepEqual(document.filter.options.map((option: any) => option.updates[0].datasets[0].rows.length), [3, 1, 1, 1]);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const executableSha256 = hash(await readFile(executable));
const captures = [];
for (const round of [1, 2]) for (const option of [0, 1, 2, 3]) {
  assert.equal(hash(await readFile(executable)), executableSha256, "Player changed during matrix");
  const scale = round === 1 ? 1 : 4 / 3;
  const capture = await captureNativePlayerWindow({ label: `round-${round}-option-${option}`,
    executable, args: ["--package", packagePath], outputDirectory: output,
    clientSize: round === 1 ? [960, 540] : [1280, 720],
    clientClick: [Math.round(60 * scale), Math.round((292 + option * 63) * scale)],
    env: { ...process.env, LOCALAPPDATA: path.join(output, "local-app-data"), DEEP_DASHBOARD_FILTER_EVIDENCE: "1" },
    presentedMarker: "native Deep2d", timeoutMs: 60_000 });
  assert(capture.playerLogTail?.includes(`selected=Some(${option})`), capture.playerLogTail);
  if (option !== 0) assert(capture.playerLogTail?.includes("Some([1])"), capture.playerLogTail);
  captures.push(capture);
  await writeFile(path.join(output, "evidence.json"), JSON.stringify({ executableSha256, packageSha256: hash(bytes),
    packagePath, scope: "single select chart data and package-declared static visibility; visual captures require review", captures }, null, 2));
}
console.log(`Filter real window pointer matrix passed: ${captures.length}/8`);
