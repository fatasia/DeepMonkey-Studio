import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { syncSourceBModels } from "./sourceBModelSync.mjs";
import { downloadAssetAtomically } from "./atomicAssetDownload.mjs";

const uid = "a".repeat(32);
const model = { uid, name: "测试泵", isDownloadable: true, user: { username: "maker" }, license: { uid: "b".repeat(32), label: "CC Attribution" }, thumbnails: { images: [{ width: 320, url: "https://fixture.invalid/thumb" }] } };
async function fixture(t) {
  const parent = path.resolve(tmpdir()); const output = await mkdtemp(path.join(parent, "bim-source-b-sync-"));
  t.after(async () => { assert.equal(path.dirname(output), parent); assert.ok(path.basename(output).startsWith("bim-source-b-sync-")); await rm(output, { recursive: true, force: true }); });
  const png = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#345678" } }).png().toBuffer();
  const requests = [];
  const options = { output, keywords: ["pump", "pump duplicate"], perKeyword: 1, maxNew: 2, report: () => undefined,
    apiJson: async request => { requests.push(request); return request.startsWith("/search") ? { results: [model] } : request.startsWith("/licenses/") ? { url: "https://creativecommons.org/licenses/by/4.0/" } : { glb: { url: "https://fixture.invalid/model" } }; },
    download: (url, target, config) => downloadAssetAtomically(url, target, { ...config, attempts: 1, fetcher: async () => new Response(url.endsWith("/model") ? glb() : png) }),
  };
  return { options, requests };
}

test("adds one actual asset, deduplicates keywords, and reuses validated bytes on rerun", async t => {
  const { options, requests } = await fixture(t);
  const first = await syncSourceBModels(options);
  assert.equal(first.added, 1); assert.equal(first.total, 1); assert.deepEqual(first.errors, []);
  assert.equal(requests.filter(value => value.endsWith("/download")).length, 1);
  assert.equal(requests.filter(value => value.startsWith("/licenses/")).length, 1);
  requests.length = 0;
  const second = await syncSourceBModels(options);
  assert.equal(second.added, 0); assert.equal(second.reused, 1);
  assert.equal(requests.filter(value => value.endsWith("/download")).length, 0);
  const catalog = JSON.parse(await readFile(path.join(options.output, "catalog.json"), "utf8"));
  assert.equal(catalog.models[0].thumbnailName, `${uid}.png`);
  assert.equal(catalog.models[0].license, "CC-BY-4.0");
  assert.equal(catalog.models[0].publicationStatus, "review-required");
  assert.ok(!(await readdir(options.output)).some(file => /lock|tmp/.test(file)));
});

test("does not reference a failed thumbnail or report search failure as an empty success", async t => {
  const { options } = await fixture(t);
  const download = options.download;
  options.download = (url, ...args) => { if (url.endsWith("/thumb")) throw new Error("thumbnail offline"); return download(url, ...args); };
  const result = await syncSourceBModels(options);
  assert.equal(result.skipped.thumbnail, 1);
  const file = path.join(options.output, "catalog.json");
  const before = await readFile(file, "utf8");
  assert.equal(JSON.parse(before).models[0].thumbnailName, undefined);
  const failure = await syncSourceBModels({ ...options, apiJson: async () => { throw new Error("service unavailable"); } });
  assert.equal(failure.errors.length, 2); assert.equal(failure.added, 0);
  assert.equal(await readFile(file, "utf8"), before);
});

test("refuses a concurrent writer and never replaces a corrupted catalog", async t => {
  const { options } = await fixture(t);
  const lock = path.join(options.output, "catalog.sync.lock");
  await writeFile(lock, "another writer");
  await assert.rejects(syncSourceBModels(options), /同步锁/);
  assert.equal(await readFile(lock, "utf8"), "another writer");
  await rm(lock);
  const catalog = path.join(options.output, "catalog.json"); await writeFile(catalog, "{broken");
  await assert.rejects(syncSourceBModels(options));
  assert.equal(await readFile(catalog, "utf8"), "{broken");
  assert.ok(!(await readdir(options.output)).includes("catalog.sync.lock"));
});

function glb() {
  const document = { asset: { version: "2.0" }, buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 };
  const raw = Buffer.from(JSON.stringify(document)); const json = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 0x20); raw.copy(json);
  const binary = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const result = Buffer.alloc(28 + json.length + binary.length);
  result.writeUInt32LE(0x46546c67, 0); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(json.length, 12); result.writeUInt32LE(0x4e4f534a, 16); json.copy(result, 20);
  result.writeUInt32LE(binary.length, 20 + json.length); result.writeUInt32LE(0x004e4942, 24 + json.length); binary.copy(result, 28 + json.length);
  return result;
}
