import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const [source, destination, ...extra] = process.argv.slice(2);
if (!source || !destination || extra.length) throw new Error("Usage: node scripts/verify-dashboard-standalone-recovery.mjs <standalone.exe> <new-output-directory>");
const output = path.resolve(destination), hash = bytes => createHash("sha256").update(bytes).digest("hex");
await mkdir(output);
const playerDirectory = path.join(output, "player"); await mkdir(playerDirectory);
const executable = path.join(playerDirectory, "Dashboard.exe"), original = await readFile(source);
assert.equal(original.subarray(-48, -40).toString("ascii"), "DMDASH01");
const length = Number(original.readBigUInt64LE(original.length - 40));
assert(Number.isSafeInteger(length) && length > 0 && length <= original.length - 48);
const payloadStart = original.length - 48 - length;
const expectedPackageHash = JSON.parse(original.subarray(payloadStart, -48).toString("utf8")).packageHash.value;
const env = { ...process.env, LOCALAPPDATA: path.join(output, "local-app-data"),
  PATH: path.join(process.env.SystemRoot ?? "C:/Windows", "System32") };

function launch(expectPresent) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], { env, cwd: playerDirectory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let log = "", presented = false, timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 15000);
    const receive = bytes => {
      log += bytes.toString();
      if (log.includes("native package recovery checkpoint committed after present")) {
        presented = true; child.kill();
      }
    };
    child.stdout.on("data", receive); child.stderr.on("data", receive);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", code => {
      clearTimeout(timeout);
      if (timedOut || presented !== expectPresent || (!expectPresent && code !== 1)) {
        reject(new Error(`Unexpected player result: timeout=${timedOut} presented=${presented} code=${code}\n${log}`));
      } else resolve(log);
    });
  });
}

async function checkpoint() {
  const root = path.join(env.LOCALAPPDATA, "DeepEngineNative", "package-recovery");
  const entries = await readdir(root); assert.equal(entries.length, 1);
  const directory = path.join(root, entries[0]);
  const files = await readdir(directory);
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [file, hash(await readFile(path.join(directory, file)))])));
}

await writeFile(executable, original);
await writeFile(path.join(output, "initial.log"), await launch(true));
const before = await checkpoint(), cases = [];
for (const kind of ["payload-hash", "payload-length", "truncated-footer"]) {
  let bytes = Buffer.from(original);
  if (kind === "payload-hash") bytes[payloadStart] ^= 1;
  if (kind === "payload-length") bytes.writeBigUInt64LE(0xffffffffffffffffn, bytes.length - 40);
  if (kind === "truncated-footer") bytes = bytes.subarray(0, bytes.length - 1);
  await writeFile(executable, bytes);
  const log = await launch(false);
  assert(log.includes(`overlay/${kind}`), log);
  assert(!log.includes("native GPU:"), "Corrupt overlay must fail before GPU startup");
  assert.deepEqual(await checkpoint(), before, "Rejected executable changed recovery files");
  await writeFile(path.join(output, `${kind}.log`), log);
  cases.push({ kind, rejectedBeforeGpu: true, checkpointUnchanged: true });
}
await writeFile(executable, original);
await writeFile(path.join(output, "restored.log"), await launch(true));
const after = await checkpoint();
const restoredActive = JSON.parse(await readFile(path.join(env.LOCALAPPDATA, "DeepEngineNative", "package-recovery",
  (await readdir(path.join(env.LOCALAPPDATA, "DeepEngineNative", "package-recovery")))[0], "active.json"), "utf8"));
assert.equal(restoredActive.hash, expectedPackageHash);
assert.equal(before[`${expectedPackageHash}.json`], hash(original.subarray(payloadStart, -48)));
assert.equal(after[`${expectedPackageHash}.json`], before[`${expectedPackageHash}.json`]);
assert.deepEqual(await readdir(playerDirectory), ["Dashboard.exe"]);
const evidence = { scope: "standalone-corruption-and-restoration", executableSha256: hash(original),
  cases, restoredPresented: true, restoredPayloadUnchanged: true, sidecars: false, nodeOnPath: false };
await writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
