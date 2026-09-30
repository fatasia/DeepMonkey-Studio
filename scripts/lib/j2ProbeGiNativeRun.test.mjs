import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runFreshProbeGiNative } from "./j2ProbeGiNativeRun.mjs";

const fixture = { cases: [{ id: "sample" }] };
const valid = { passed: true, runs: 2, results: [{ id: "sample", passed: true, value: [1, 2, 3] }] };
const log = "test j2_probe_gi_production_vectors ... ok\ntest result: ok. 1 passed; 0 failed";

async function isolated(run) {
  const out = await mkdtemp(path.join(tmpdir(), "j2-probe-native-"));
  try {
    await writeFile(path.join(out, "native.json"), JSON.stringify(valid));
    await writeFile(path.join(out, "evidence.json"), '{"passed":true}');
    await run(out);
  } finally { await rm(out, { recursive: true, force: true }); }
}

test("failed Cargo cannot reuse matching old Native/evidence files", () => isolated(async out => {
  await assert.rejects(runFreshProbeGiNative({ root: out, out, fixture, spawn() {
    assert.equal(existsSync(path.join(out, "native.json")), false);
    assert.equal(existsSync(path.join(out, "evidence.json")), false);
    return { status: 1, stdout: "test failed" };
  } }), /Native probe leg failed/);
  assert.equal(existsSync(path.join(out, "native.json")), false);
  assert.equal(existsSync(path.join(out, "evidence.json")), false);
}));

test("empty filter is rejected even if a JSON was written", () => isolated(async out => {
  await assert.rejects(runFreshProbeGiNative({ root: out, out, fixture, spawn() {
    writeFileSync(path.join(out, "native.json"), JSON.stringify(valid));
    return { status: 0, stdout: "test result: ok. 0 passed; 0 failed" };
  } }), /did not execute/);
  assert.equal(existsSync(path.join(out, "native.json")), false);
}));

test("successful log without newly written evidence is rejected", () => isolated(async out => {
  await assert.rejects(runFreshProbeGiNative({ root: out, out, fixture,
    spawn: () => ({ status: 0, stdout: log }) }), /ENOENT/);
}));

test("partial or duplicate sample evidence is rejected", () => isolated(async out => {
  await assert.rejects(runFreshProbeGiNative({ root: out, out, fixture, spawn() {
    writeFileSync(path.join(out, "native.json"), JSON.stringify({ ...valid, results: [] }));
    return { status: 0, stdout: log };
  } }), /complete successful/);
}));

test("only a successful named test plus fresh complete evidence passes", () => isolated(async out => {
  const result = await runFreshProbeGiNative({ root: out, out, fixture, spawn(command, args, options) {
    assert.equal(command, "cargo"); assert.ok(args.includes("j2_probe_gi_parity"));
    assert.equal(options.windowsHide, true);
    writeFileSync(path.join(out, "native.json"), JSON.stringify(valid));
    return { status: 0, stdout: log };
  } });
  assert.deepEqual(result, valid);
  assert.equal(await readFile(path.join(out, "native.log"), "utf8"), log);
}));
