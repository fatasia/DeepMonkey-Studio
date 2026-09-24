import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const [executableArg, expectedArg, outputArg] = process.argv.slice(2);
if (!executableArg || !expectedArg || !outputArg || process.argv.length !== 5)
  throw new Error("Usage: node scripts/verify-dashboard-standalone.mjs <standalone.exe> <expected-runtime.json> <new-evidence-directory>");
const executable = path.resolve(executableArg), output = path.resolve(outputArg);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
await mkdir(output);
const expectedBytes = await readFile(expectedArg), expected = JSON.parse(expectedBytes);
const localAppData = path.join(output, "local-app-data");
// Strip developer runtimes from PATH and isolate the player's recovery checkpoint.
const env = { ...process.env, LOCALAPPDATA: localAppData, PATH: path.join(process.env.SystemRoot ?? "C:/Windows", "System32") };
const licenses = execFileSync(executable, ["--licenses"], { env, windowsHide: true, encoding: "utf8", timeout: 15_000 });
assert(licenses.includes("MIT License"));
assert(licenses.includes("ETHICAL RESTRICTIONS"));
await writeFile(path.join(output, "licenses.txt"), licenses);
assert.deepEqual(await readdir(path.dirname(executable)), [path.basename(executable)], "Player directory must contain only the EXE");
let log = "", presented = false;
await new Promise((resolve, reject) => {
  const child = spawn(executable, [], { env, cwd: path.dirname(executable), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const timeout = setTimeout(() => child.kill(), 15_000);
  const receive = bytes => {
    log += bytes.toString();
    if (!presented && log.includes("native package recovery checkpoint committed after present")) {
      presented = true;
      child.kill();
    }
  };
  child.stdout.on("data", receive); child.stderr.on("data", receive);
  child.once("error", error => { clearTimeout(timeout); reject(error); });
  child.once("close", () => { clearTimeout(timeout); presented ? resolve() : reject(new Error(`No presented checkpoint: ${log}`)); });
});
await writeFile(path.join(output, "player.log"), log);
assert(log.includes("native GPU:"));
const recovery = path.join(localAppData, "DeepEngineNative", "package-recovery");
const entries = await readdir(recovery);
assert.equal(entries.length, 1);
const directory = path.join(recovery, entries[0]);
const active = JSON.parse(await readFile(path.join(directory, "active.json"), "utf8"));
assert.equal(active.hash, expected.packageHash.value);
assert.equal(sha(await readFile(path.join(directory, `${active.hash}.json`))), sha(expectedBytes));
assert.deepEqual(await readdir(path.dirname(executable)), [path.basename(executable)]);
const evidence = { scope: "standalone-no-argument-native-present", executableSha256: sha(await readFile(executable)),
  artifactSha256: sha(expectedBytes), packageHash: active.hash, nodeRuntimeOnPath: false,
  sidecarFiles: false, presentedCheckpoint: true, terminatedAfterCheckpoint: true };
await writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
