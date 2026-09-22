import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { rasterizeNativeTextBatch } from "./nativeTextRasterizer.mjs";
import { sha256 } from "./nativeTextRasterWire.mjs";
const fixture = fileURLToPath(new URL("./nativeTextRasterBatchFixture.mjs", import.meta.url));
const requests = () => ["A", "B"].map(text => {
  const bytes = Buffer.from([1,2,3]), font = { sha256: sha256(bytes), faceIndex: 0 };
  return { schema: "deep-engine.text-raster-request", schemaVersion: 1, locale: "en-US",
    fonts: [{ ...font, dataBase64: bytes.toString("base64") }], request: { text, font, weight: 400,
      style: "normal", align: "left", verticalAlign: "top", wrap: "none", fontSize: 16, lineHeight: 20,
      width: 2, height: 2, color: [255,255,255,255] } };
});
for (const mode of ["ok", "missing", "reordered", "pixels", "timeout", "cancel"]) test(`batch ${mode}: every item validated and child joined before cleanup`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deep-batch-test-")), children = [], controller = new AbortController();
  const spawnProcess = (executable, args, options) => {
    assert.equal(options.windowsHide, true); assert.equal(options.shell, false);
    const child = spawn(executable, [fixture, ...args], { ...options,
      env: { ...process.env, TEXT_FIXTURE_MODE: mode === "cancel" ? "timeout" : mode } });
    children.push(child); if (mode === "cancel") controller.abort(new Error("cancel batch")); return child;
  };
  try {
    const input = requests(), result = rasterizeNativeTextBatch({ nativeExecutable: process.execPath,
      requests: input, signal: controller.signal }, { temporaryRoot: root, spawnProcess, timeoutMs: mode === "timeout" ? 100 : 5000 });
    if (mode === "ok") {
      const outputs = await result; assert.equal(outputs.length, 2);
      outputs.forEach((output, index) => assert.equal(output.evidence.sourceSha256, sha256(Buffer.from(JSON.stringify(input[index])))));
    } else await assert.rejects(result, /batch result|source identity|pixel bytes|timed out|cancel batch/);
    assert.equal(children.length, 1); assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("batch rejects invalid grouping, count and cancellation before any producer", async () => {
  const invoke = (input, signal) => rasterizeNativeTextBatch({ nativeExecutable: "missing", requests: input, signal });
  await assert.rejects(invoke([]), /count/);
  await assert.rejects(invoke(Array(513).fill(requests()[0])), /count/);
  const input = requests(); input[1].locale = "zh-CN";
  await assert.rejects(invoke(input), /identical/);
  await assert.rejects(invoke(requests(), AbortSignal.abort()), /abort/i);
});
