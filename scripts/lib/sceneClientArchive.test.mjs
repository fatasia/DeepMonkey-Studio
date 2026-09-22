import assert from "node:assert/strict";
import test from "node:test";
import { verifySceneClientArchive } from "./sceneClientArchive.mjs";
import { archiveFixture, centralEntries, renameRawEntry } from "./sceneClientArchiveFixture.mjs";

test("validates indexed local icon bytes and rejects signed format mismatches", async () => {
  const path = "branding/icon.png", branding = { applicationName: "客户园区", iconPath: path };
  const content = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer;
  const valid = await archiveFixture({ branding, payloads: [{ path, content }] });
  assert.deepEqual((await verifySceneClientArchive(valid.buffer)).manifest.branding, branding);
  const bad = await archiveFixture({ branding, payloads: [{ path, content: "not a PNG" }] });
  await assert.rejects(verifySceneClientArchive(bad.buffer), /图标格式/);
  const changed = await archiveFixture({ branding, payloads: [{ path, content }], editZip: zip => zip.file(path, "tampered") });
  await assert.rejects(verifySceneClientArchive(changed.buffer));
});

test("accepts real streamed descriptors and rejects missing or corrupt descriptors", async () => {
  const streamed = await archiveFixture({ compression: "DEFLATE", streamFiles: true });
  assert.equal((await verifySceneClientArchive(streamed.buffer)).fileCount, 5);
  const broken = Buffer.from(streamed.buffer);
  const descriptor = broken.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]));
  broken[descriptor + 4] ^= 1;
  await assert.rejects(verifySceneClientArchive(broken), /descriptor/);
  const plain = await archiveFixture();
  const entry = centralEntries(plain.buffer).find(entry => entry.name === "runtime.json");
  plain.buffer.writeUInt16LE(8, entry.offset + 8);
  plain.buffer.writeUInt16LE(8, entry.local + 6);
  plain.buffer.writeUInt32LE(123, entry.local + 14);
  await assert.rejects(verifySceneClientArchive(plain.buffer), /descriptor/);
});

for (const compression of ["STORE", "DEFLATE"]) test(`verifies real ${compression} archive with Chinese paths and binary content`, async () => {
  const fixture = await archiveFixture({ compression, payloads: [
    { path: "资源/中文 文件.bin", content: new Uint8Array([0, 128, 255]).buffer },
    { path: "assets/empty.txt", content: "" },
  ] });
  const result = await verifySceneClientArchive(fixture.buffer, { expectedTarget: "three-webview" });
  assert.deepEqual(result.manifest, fixture.manifest);
  assert.equal(result.fileCount, fixture.manifest.files.length);
  assert.equal(result.totalBytes, fixture.manifest.files.reduce((sum, file) => sum + file.bytes, 0)
    + Buffer.byteLength(JSON.stringify(fixture.manifest)));
});

test("rejects missing and undeclared payloads", async () => {
  for (const editZip of [zip => zip.remove("runtime.json"), zip => zip.file("extra.txt", "unexpected")]) {
    const { buffer } = await archiveFixture({ editZip });
    await assert.rejects(verifySceneClientArchive(buffer));
  }
});

test("rejects valid ZIP data that differs from the indexed bytes", async () => {
  const { buffer } = await archiveFixture({ editZip: zip => zip.file("runtime.json", "[]") });
  await assert.rejects(verifySceneClientArchive(buffer));
});

test("rejects CRC corruption even when content SHA remains unchanged", async () => {
  const { buffer } = await archiveFixture();
  const entry = centralEntries(buffer).find(entry => entry.name === "runtime.json");
  const corrupted = Buffer.from(buffer), crc = (corrupted.readUInt32LE(entry.offset + 16) ^ 1) >>> 0;
  corrupted.writeUInt32LE(crc, entry.offset + 16); corrupted.writeUInt32LE(crc, entry.local + 14);
  await assert.rejects(verifySceneClientArchive(corrupted));
});

test("detects duplicate raw central entries before a ZIP filename map could overwrite them", async () => {
  const { buffer } = await archiveFixture({ payloads: [{ path: "assets/a.bin", content: "same" }],
    editZip: zip => zip.file("assets/b.bin", "same") });
  await assert.rejects(verifySceneClientArchive(renameRawEntry(buffer, "assets/b.bin", "assets/a.bin")));
});

test("rejects central-directory case collisions", async () => {
  const { buffer } = await archiveFixture({ payloads: [{ path: "assets/a.bin", content: "same" }],
    editZip: zip => zip.file("assets/A.bin", "same") });
  await assert.rejects(verifySceneClientArchive(buffer));
});

for (const path of ["../unsafe/", "/absolute/", "a/../unsafe/", "a\\unsafe/", "manifest.json/child/"]) {
  test(`rejects unsafe raw directory ${JSON.stringify(path)}`, async () => {
    const { buffer } = await archiveFixture({ editZip: zip => zip.file(path, "", { dir: true, createFolders: false }) });
    await assert.rejects(verifySceneClientArchive(buffer));
  });
}

test("rejects symlinks instead of interpreting them as ordinary indexed text", async () => {
  const { buffer } = await archiveFixture({ payloads: [{ path: "assets/link.txt", content: "runtime.json" }],
    editZip: zip => zip.file("assets/link.txt", "runtime.json", { unixPermissions: 0o120777 }) });
  await assert.rejects(verifySceneClientArchive(buffer));
});

test("rejects file/directory prefix collisions", async () => {
  const { buffer } = await archiveFixture({ payloads: [{ path: "assets/child.txt", content: "ok" }],
    editZip: zip => zip.file("assets", "not a directory") });
  await assert.rejects(verifySceneClientArchive(buffer));
});

test("enforces archive, manifest, file, expanded-total and entry limits", async () => {
  const { buffer } = await archiveFixture({ compression: "DEFLATE", payloads: [{ path: "assets/large.txt", content: "a".repeat(8192) }] });
  for (const limits of [{ archiveBytes: buffer.length - 1 }, { manifestBytes: 16 }, { fileBytes: 1024 },
    { totalBytes: 100 }, { entries: 2 }]) await assert.rejects(verifySceneClientArchive(buffer, { limits }));
});

test("rejects lying uncompressed-size metadata during bounded inflation", async () => {
  const { buffer } = await archiveFixture({ compression: "DEFLATE", payloads: [{ path: "assets/large.txt", content: "a".repeat(8192) }] });
  const entry = centralEntries(buffer).find(entry => entry.name === "assets/large.txt"), corrupted = Buffer.from(buffer);
  corrupted.writeUInt32LE(1, entry.offset + 24); corrupted.writeUInt32LE(1, entry.local + 22);
  await assert.rejects(verifySceneClientArchive(corrupted, { limits: { fileBytes: 1024 } }));
});

test("rejects pre-cancellation and cancellation after invocation", async () => {
  const { buffer } = await archiveFixture({ compression: "DEFLATE", payloads: [{ path: "assets/large.txt", content: "a".repeat(65536) }] });
  const before = new AbortController(); before.abort();
  await assert.rejects(verifySceneClientArchive(buffer, { signal: before.signal }), { name: "AbortError" });
  const during = new AbortController(), pending = verifySceneClientArchive(buffer, { signal: during.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" }); queueMicrotask(() => during.abort()); await rejected;
});

test("rejects target mismatches and malformed ZIP bytes", async () => {
  const { buffer } = await archiveFixture();
  await assert.rejects(verifySceneClientArchive(buffer, { expectedTarget: "deep-native" }));
  await assert.rejects(verifySceneClientArchive(Buffer.from("not a zip")));
  await assert.rejects(verifySceneClientArchive(buffer.subarray(0, buffer.length - 10)));
});

test("rejects a local-only filename change with an unchanged central directory", async () => {
  const { buffer } = await archiveFixture();
  const entry = centralEntries(buffer).find(entry => entry.name === "runtime.json");
  buffer.write("runtimE.json", entry.local + 30, "utf8");
  await assert.rejects(verifySceneClientArchive(buffer), /本地与中央目录不一致/);
});

for (const [field, offset, width, mismatch] of [
  ["flags", 6, 2, /本地与中央目录不一致/],
  ["method", 8, 2, /本地与中央目录不一致/],
  ["compressed size", 18, 4, /大小头不一致/],
  ["uncompressed size", 22, 4, /大小头不一致/],
  ["CRC", 14, 4, /CRC 头不一致/],
]) test(`rejects local-only ${field} corruption`, async () => {
  const { buffer } = await archiveFixture();
  const entry = centralEntries(buffer).find(entry => entry.name === "runtime.json");
  if (width === 2) buffer.writeUInt16LE(buffer.readUInt16LE(entry.local + offset) ^ 8, entry.local + offset);
  else buffer.writeUInt32LE((buffer.readUInt32LE(entry.local + offset) ^ 1) >>> 0, entry.local + offset);
  await assert.rejects(verifySceneClientArchive(buffer), mismatch);
});

test("rejects empty directories unrelated to indexed payloads", async () => {
  const { buffer } = await archiveFixture({ editZip: zip => zip.folder("unneeded") });
  await assert.rejects(verifySceneClientArchive(buffer), /无负载的目录/);
});

test("rejects a payload parent directory with nonzero CRC", async () => {
  const { buffer } = await archiveFixture({ payloads: [{ path: "assets/file.txt", content: "ok" }] });
  const entry = centralEntries(buffer).find(entry => entry.name === "assets/");
  buffer.writeUInt32LE(1, entry.offset + 16); buffer.writeUInt32LE(1, entry.local + 14);
  await assert.rejects(verifySceneClientArchive(buffer), /目录含有负载或 CRC 无效/);
});

test("rejects overlapping local file ranges despite consistent individual headers", async () => {
  const { buffer } = await archiveFixture();
  const [first, next] = centralEntries(buffer).sort((a, b) => a.local - b.local);
  const originalSize = buffer.readUInt32LE(first.offset + 20);
  const dataStart = first.local + 30 + buffer.readUInt16LE(first.local + 26) + buffer.readUInt16LE(first.local + 28);
  assert.equal(dataStart + originalSize, next.local);
  // Both STORE sizes and both headers agree, but the first payload covers one byte of the next header.
  for (const offset of [first.offset + 20, first.offset + 24, first.local + 18, first.local + 22]) {
    buffer.writeUInt32LE(originalSize + 1, offset);
  }
  await assert.rejects(verifySceneClientArchive(buffer), /ZIP 文件区间重叠/);
});

test("snapshots caller-owned bytes synchronously before asynchronous ZIP reads", async () => {
  const { buffer, manifest } = await archiveFixture({ compression: "DEFLATE" });
  const pending = verifySceneClientArchive(buffer);
  buffer.fill(0);
  const result = await pending;
  assert.deepEqual(result.manifest, manifest);
  assert.equal(result.fileCount, manifest.files.length);
});
