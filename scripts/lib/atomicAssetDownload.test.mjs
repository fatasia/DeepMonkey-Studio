import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AssetValidationError, downloadAssetAtomically } from "./atomicAssetDownload.mjs";

async function fixture(t) {
  const parent = path.resolve(tmpdir());
  const directory = await mkdtemp(path.join(parent, "bim-atomic-asset-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), parent);
    assert.ok(path.basename(directory).startsWith("bim-atomic-asset-"));
    await rm(directory, { recursive: true, force: true });
  });
  const target = path.join(directory, "model.glb");
  await writeFile(target, "original");
  return { directory, target };
}

test("validates complete bytes before replacing the final file", async t => {
  const { directory, target } = await fixture(t);
  const result = await downloadAssetAtomically("https://example.invalid/model", target, {
    maxBytes: 32, attempts: 1, fetcher: async () => new Response("new-model", { headers: { "content-length": "9" } }),
    validate: async (temporary, bytes) => {
      assert.equal(await readFile(target, "utf8"), "original");
      assert.equal(await readFile(temporary, "utf8"), "new-model");
      assert.equal(bytes, 9); return { valid: true };
    },
  });
  assert.equal(await readFile(target, "utf8"), "new-model");
  assert.deepEqual(result, { bytes: 9, inspection: { valid: true } });
  assert.deepEqual(await readdir(directory), ["model.glb"]);
});

for (const [name, response] of [
  ["unannounced byte overflow", () => new Response("large payload")],
  ["declared byte overflow", () => new Response("tiny", { headers: { "content-length": "99" } })],
  ["truncated response", () => new Response("a", { headers: { "content-length": "4" } })],
  ["empty body", () => new Response("")],
  ["network error", () => { throw new Error("offline"); }],
  ["stream interruption", () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.error(new Error("stream disconnected")); } }))],
]) test(`${name} preserves the old final file and removes only its partial`, async t => {
  const { directory, target } = await fixture(t);
  await assert.rejects(downloadAssetAtomically("https://example.invalid/model", target, { maxBytes: 8, attempts: 1, fetcher: async () => response(), validate: async () => { throw new Error("should not validate"); } }));
  assert.equal(await readFile(target, "utf8"), "original");
  assert.deepEqual(await readdir(directory), ["model.glb"]);
});

test("invalid content is not published and is not wastefully retried", async t => {
  const { target } = await fixture(t); let requests = 0;
  await assert.rejects(downloadAssetAtomically("https://example.invalid/model", target, {
    maxBytes: 20, fetcher: async () => { requests++; return new Response("not glb"); },
    validate: async () => { throw new AssetValidationError("not glb"); },
  }), /not glb/);
  assert.equal(requests, 1);
  assert.equal(await readFile(target, "utf8"), "original");
});
