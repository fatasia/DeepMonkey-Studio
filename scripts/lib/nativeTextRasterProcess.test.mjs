import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { truncateSync, appendFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { boundedRead } from "./nativeTextRasterProcess.mjs";

async function fixture(run, size = 131072) {
  const directory = await mkdtemp(path.join(tmpdir(), "deep-raster-read-"));
  const file = path.join(directory, "input.bin");
  const bytes = Buffer.alloc(size, 37);
  try { await writeFile(file, bytes); await run(file, bytes, directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
test("bounded read returns exact bytes without a concat-sized second allocation", async () => {
  for (const size of [0, 3, 65537, 131072]) await fixture(async (file, bytes) => {
    const actual = await boundedRead(file, size);
    assert.deepEqual(actual, bytes);
    assert.equal(actual.buffer.byteLength, size);
  }, size);
});
test("invalid budget, oversized input and directory are rejected", async () => {
  await fixture(async (file, bytes, directory) => {
    await assert.rejects(boundedRead(file, -1), /Invalid/);
    await assert.rejects(boundedRead(file, bytes.length - 1), /byte budget/);
    await assert.rejects(boundedRead(directory, bytes.length), /regular file/);
  });
});
for (const mode of ["truncate", "grow", "overwrite", "cancel"]) {
  test(`mid-read ${mode} rejects and allows cleanup`, async () => {
    await fixture(async (file, bytes) => {
      let checks = 0;
      const signal = { throwIfAborted() {
        // Initial cancellation check, first chunk, then the second chunk.
        if (++checks !== 3) return;
        if (mode === "cancel") throw new Error("cancelled read");
        if (mode === "truncate") truncateSync(file, 1);
        if (mode === "grow") appendFileSync(file, Buffer.from([1]));
        if (mode === "overwrite") {
          writeFileSync(file, Buffer.alloc(bytes.length, 19));
          utimesSync(file, new Date(0), new Date(0));
        }
      } };
      await assert.rejects(boundedRead(file, bytes.length + 1, signal), /changed during read|cancelled read/);
      await rm(file);
    });
  });
}
test("pre-cancelled calls do not attempt filesystem access", async () => {
  const controller = new AbortController(); controller.abort(new Error("already cancelled"));
  await assert.rejects(boundedRead("does-not-exist", 10, controller.signal), /already cancelled/);
});
