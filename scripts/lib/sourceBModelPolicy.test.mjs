import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { readSourceBCatalog, sourceBModelId, sourceBModelLicense, validateSourceBGlb, validateSourceBThumbnail } from "./sourceBModelPolicy.mjs";

const uid = "a".repeat(32);
const model = { uid, name: "工业泵", user: { username: "maker" }, license: { url: "https://creativecommons.org/licenses/by/4.0/" } };
test("allows precise CC0 and CC-BY-4.0 with complete attribution", () => {
  const result = sourceBModelLicense(model);
  assert.equal(result.license, "CC-BY-4.0"); assert.match(result.attribution, /maker.*Sketchfab/);
  assert.match(result.attribution, /creativecommons.org\/licenses\/by\/4.0/);
  assert.equal(sourceBModelLicense({ ...model, license: { url: "http://creativecommons.org/publicdomain/zero/1.0/" } }).license, "CC0-1.0");
});
test("rejects ambiguous labels, restricted terms, forged hosts and missing BY attribution", () => {
  for (const license of [{ label: "CC Attribution" }, { url: "https://creativecommons.org/licenses/by-nc/4.0/" }, { url: "https://creativecommons.org.attacker.invalid/licenses/by/4.0/" }, { url: "https://creativecommons.org/licenses/by-sa/4.0/" }]) assert.equal(sourceBModelLicense({ ...model, license }), undefined);
  assert.equal(sourceBModelLicense({ ...model, user: {} }), undefined);
  assert.throws(() => sourceBModelId("../model"));
});

test("refuses corrupted catalogs and validates actual GLB and image bytes", async t => {
  const parent = path.resolve(tmpdir()); const directory = await mkdtemp(path.join(parent, "bim-source-b-policy-"));
  t.after(async () => { assert.equal(path.dirname(directory), parent); assert.ok(path.basename(directory).startsWith("bim-source-b-policy-")); await rm(directory, { recursive: true, force: true }); });
  const catalog = path.join(directory, "catalog.json");
  assert.deepEqual((await readSourceBCatalog(catalog)).models, []);
  await writeFile(catalog, "{broken"); await assert.rejects(readSourceBCatalog(catalog));
  await writeFile(catalog, JSON.stringify({ schemaVersion: 1, source: "sketchfab", models: [{ uid, fileName: "../model.glb" }] }));
  await assert.rejects(readSourceBCatalog(catalog), /越界/);
  const file = path.join(directory, "model.part"); await writeFile(file, "<html>failure</html>");
  await assert.rejects(validateSourceBGlb(file, (await readFile(file)).length));
  await assert.rejects(validateSourceBThumbnail(file), /缩略图验证失败/);
  await sharp({ create: { width: 320, height: 240, channels: 3, background: "#345678" } }).jpeg().toFile(file);
  assert.equal((await validateSourceBThumbnail(file)).valid, true);
  assert.equal((await sharp(file).metadata()).format, "png");
});
