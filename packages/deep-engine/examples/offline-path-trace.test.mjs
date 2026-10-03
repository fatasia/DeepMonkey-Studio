import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { writePathTraceFixture, verifyPathTraceFixtureHdr } from "./offline-path-trace-fixture.mjs";

const cli = fileURLToPath(new URL("./offline-path-trace.mjs", import.meta.url));
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "deep-pt-cli-"));
  return { directory, ...await writePathTraceFixture(directory), output: join(directory, "result.hdr") };
}
function argsOf(f, extras = []) {
  return ["--packet", f.packetPath, "--camera", f.cameraPath, "--output", f.output,
    "--width", "32", "--height", "16", "--spp", "16384", "--seed", "17", ...extras];
}
function run(args, cancelOnProgress = false) {
  // On Windows child.kill(SIGINT) terminates a process without delivering Node's JS signal hook.
  // Dispatch that real process hook over stdin; the unmodified CLI then owns AbortController.
  const hook = `process.argv = ['node', ${JSON.stringify(cli)}, ...JSON.parse(process.env.PT_EXAMPLE_ARGS)];
process.stdin.once('data', () => { process.emit('SIGINT'); process.stdin.destroy(); });
await import(${JSON.stringify(new URL("./offline-path-trace.mjs", import.meta.url).href)});`;
  const child = spawn(process.execPath, cancelOnProgress ? ["--input-type=module", "-e", hook] : [cli, ...args], {
    env: { ...process.env, PT_EXAMPLE_ARGS: JSON.stringify(args) }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let stdout = "", stderr = "", sent = false;
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => {
    stderr += data;
    if (cancelOnProgress && !sent && stderr.includes('"phase":"progress"')) { sent = true; child.stdin.write("cancel\n"); }
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("CLI timed out")); }, 60000);
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr }); });
  });
}
const absent = async path => assert.rejects(access(path), { code: "ENOENT" });

test("real built-SDK CLI renders formal non-empty dielectric/full-metal PBR instances and HDR analytic evidence", async () => {
  const f = await fixture(), result = await run(argsOf(f));
  assert.equal(result.code, 0, result.stderr);
  const verified = await verifyPathTraceFixtureHdr(f.output);
  assert.equal(verified.sampleCount, 16384); assert.equal(verified.seed, 17);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, "final"); assert.ok(receipt.maxRelativeStandardError <= 0.05);
});

test("noise gate rejects final output at one sample", async () => {
  const f = await fixture(), result = await run(argsOf(f, ["--spp", "1"]));
  assert.equal(result.code, 2, result.stderr); assert.equal(JSON.parse(result.stdout).status, "rejected-noise");
  await absent(f.output); await absent(f.output + ".receipt.json");
});

test("explicit preview writes only a labelled preview file and receipt", async () => {
  const f = await fixture(), result = await run(argsOf(f, ["--spp", "1", "--preview"]));
  assert.equal(result.code, 2, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, "preview"); assert.equal(receipt.converged, false);
  assert.equal(receipt.maxRelativeStandardError, null); assert.match(receipt.output, /\.preview\.hdr$/);
  await access(receipt.output); await access(receipt.receiptPath); await absent(f.output);
});

test("CLI SIGINT hook cancels asynchronous sample work and releases buffers without publishing", async () => {
  const f = await fixture(), result = await run(argsOf(f, ["--spp", "100000", "--batch", "2"]), true);
  assert.equal(result.code, 130, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, "cancelled"); assert.equal(receipt.residentBytes, 0);
  assert.ok(receipt.sampleCount > 0 && receipt.sampleCount < 100000);
  await absent(f.output); await absent(f.output + ".receipt.json");
});

test("unsupported single-sided surface is rejected by the actual SDK profile without output", async () => {
  const f = await fixture(), packet = JSON.parse(await readFile(f.packetPath, "utf8"));
  packet.materials[0].doubleSided = false; await writeFile(f.packetPath, JSON.stringify(packet));
  const result = await run(argsOf(f));
  assert.equal(result.code, 1); assert.match(result.stderr, /single-sided/); await absent(f.output);
});

test("CLI refuses to overwrite an existing output", async () => {
  const f = await fixture(); await writeFile(f.output, "preserve");
  const result = await run(argsOf(f));
  assert.equal(result.code, 1); assert.match(result.stderr, /already exists/);
  assert.equal(await readFile(f.output, "utf8"), "preserve");
});
