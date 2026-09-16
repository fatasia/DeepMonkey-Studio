import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";
import { rasterizeNativeText } from "./nativeTextRasterizer.mjs";
import { sha256 } from "./nativeTextRasterWire.mjs";

const fixture = fileURLToPath(new URL("./nativeTextRasterFixture.mjs", import.meta.url));
const outputRoot = fileURLToPath(new URL("../../", import.meta.url));
const request = () => { const data = Buffer.from([1, 2, 3]); const font = { sha256: sha256(data), faceIndex: 0 };
  return { schema: "deep-engine.text-raster-request", schemaVersion: 1, locale: "zh-CN",
    fonts: [{ ...font, dataBase64: data.toString("base64") }], request: { text: "字", font, weight: 400,
      style: "normal", align: "left", verticalAlign: "center", wrap: "word", fontSize: 16, lineHeight: 20, width: 2, height: 2, color: [255, 255, 255, 255] } }; };
async function harness(mode, fn) {
  const root = await mkdtemp(path.join(outputRoot, "node-raster-test-"));
  const children = [], closeDirectories = [];
  const spawnProcess = (executable, args, options) => {
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(args[0], "--rasterize-text"); assert.equal(args[2], "--output");
    assert.equal(path.dirname(args[1]), options.cwd); assert.equal(path.dirname(args[3]), options.cwd);
    assert.notEqual(executable, process.execPath);
    const child = spawn(mode === "spawn-missing" ? `${executable}.missing` : executable,
      [fixture, ...args], { ...options, env: { ...process.env, TEXT_FIXTURE_MODE: mode } });
    children.push(child); child.once("close", () => closeDirectories.push(existsSync(options.cwd))); return child;
  };
  const invoke = (input = request(), signal, timeoutMs = 5000) => rasterizeNativeText({ nativeExecutable: process.execPath,
    request: input, signal }, { spawnProcess, temporaryRoot: root, timeoutMs });
  try { await fn(invoke, children); assert.deepEqual(await readdir(root), []); assert.ok(closeDirectories.every(Boolean)); }
  finally { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await rm(root, { recursive: true, force: true }); }
}
test("real producer process returns verified bytes and frozen source/executable evidence", async () => {
  await harness("ok", async invoke => {
    const input = request(), result = await invoke(input);
    assert.equal(result.rgba.length, 16);
    assert.equal(result.evidence.sourceSha256, sha256(Buffer.from(JSON.stringify(input))));
    assert.equal(result.evidence.executableSha256, sha256(await readFile(process.execPath)));
    assert.equal(result.evidence.pixelSha256, sha256(result.rgba));
    assert.equal(result.evidence.scope, "native-text-raster");
  });
});
for (const [mode, error] of [["source", /source identity/], ["pixels", /pixel bytes\/hash/], ["dimensions", /dimensions/],
  ["unfrozen", /unfrozen/], ["forgedstyle", /weight\/style differs/], ["forgedweight", /weight\/style differs/],
  ["base64", /base64/], ["lines", /line count/], ["ink", /ink extent/], ["unknown", /unexpected fields/],
  ["failure", /exited 7: fixture exit failure/], ["missing", /ENOENT/], ["utf8", /encoded data/], ["oversized", /byte budget/],
  ["diagnostic", /diagnostics exceed/], ["request-tamper", /source changed/], ["spawn-missing", /ENOENT/]]) {
  test(`real child ${mode} is rejected and its private directory is cleaned`, async () => {
    await harness(mode, async invoke => assert.rejects(invoke(), error));
  });
}
test("timeout terminates the real child before cleanup", async () => {
  await harness("timeout", async (invoke, children) => {
    await assert.rejects(invoke(request(), undefined, 100), /timed out/);
    assert.equal(children.length, 1); assert.ok(children[0].exitCode !== null || children[0].signalCode !== null);
  });
});
test("cancellation terminates the real child before cleanup", async () => {
  await harness("timeout", async (invoke, children) => {
    const controller = new AbortController(), promise = invoke(request(), controller.signal);
    while (!children.length) await new Promise(resolve => setTimeout(resolve, 5));
    controller.abort(new Error("cancelled by test"));
    await assert.rejects(promise, /cancelled by test/);
    assert.ok(children[0].exitCode !== null || children[0].signalCode !== null);
  });
});
test("pre-cancelled and invalid frozen inputs never launch a producer", async () => {
  await harness("ok", async (invoke, children) => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(invoke(request(), controller.signal), /abort/i);
    const invalid = request(); invalid.fonts[0].sha256 = "0".repeat(64);
    await assert.rejects(invoke(invalid), /font hash/);
    const tooWide = request(); tooWide.request.width = 2049;
    await assert.rejects(invoke(tooWide), /dimensions/);
    const mistyped = request(); mistyped.request.font = { ...mistyped.request.font, faceIndex: "0" };
    await assert.rejects(invoke(mistyped), /unfrozen requested font/);
    assert.equal(children.length, 0);
  });
});
test("empty text evidence and repeated paragraph indices in wrapped runs are accepted", async () => {
  await harness("empty", async invoke => { const input = request(); input.request.text = ""; assert.equal((await invoke(input)).result.usedFaces.length, 0); });
  await harness("wrapped", async invoke => assert.equal((await invoke()).result.lines.length, 2));
});
test("request metrics and required vertical alignment follow the Native wire limits", async () => {
  await harness("ok", async (invoke, children) => {
    for (const [key, value] of [["fontSize", 257], ["lineHeight", 513], ["height", 2049], ["text", "x".repeat(16385)],
      ["verticalAlign", "baseline"], ["fontSize", 0], ["weight", 1001]]) {
      const input = request(); input.request[key] = value; await assert.rejects(invoke(input), /Invalid text raster wire/);
    }
    const missing = request(); delete missing.request.verticalAlign;
    await assert.rejects(invoke(missing), /unexpected fields/);
    assert.equal(children.length, 0);
    for (const verticalAlign of ["top", "center", "bottom"]) {
      const input = request(); Object.assign(input.request, { fontSize: 256, lineHeight: 512, verticalAlign });
      assert.equal((await invoke(input)).result.width, input.request.width);
    }
  });
});
