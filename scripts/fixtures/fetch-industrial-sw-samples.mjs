import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = path.join(root, "data/external-assets/industrial-format-plan/samples/solidworks-sheetmetal-20260918");
const repository = "N1-Conception/SolidWorks-SheetMetal-Designs";
const commit = "7dc050ee10a9137f7cd2b653f191174ddfa98cc7";
const licenseBlob = "59ee69d4f142fdf959b49c4cb624d1bc9f60825b";
const samples = [
  ["01_Perforated cylinder", 1, "0cd6ef4dc09b78ae0ce1e1d2388ed3f136595713", 459389, "带孔薄壁圆筒"],
  ["02_Mounting Bracket", 2, "c4f63a4f7bb21ebcf90e078dcf7a405b93451812", 202750, "钣金安装支架"],
  ["03_Air Flow Guard Bracket", 3, "799db78e008851c26f70d59f0d32d375f138bda8", 782562, "气流防护支架"],
  ["04_Stairs", 4, "2695dd6a07a5b5ec6f74ebc027a76733b07074bd", 1314136, "钣金阶梯"],
  ["05_Collar support", 5, "34d8057541166e6b51c1df1fc50b406484479c02", 273271, "环箍支撑件"],
];
const records = [];
for (const [folder, index, blob, bytes, expectedGeometry] of samples) {
  const sampleDirectory = path.join(directory, `part-${index}`);
  await mkdir(sampleDirectory, { recursive: true });
  const license = await fetchFrozen(`${folder}/LICENSE.txt`, licenseBlob, 1083, path.join(sampleDirectory, "LICENSE.txt"));
  assert(license.bytes.toString("utf8").includes("Permission is hereby granted"), "Missing MIT grant");
  const model = await fetchFrozen(`${folder}/project${index}-nishchay.SLDPRT`, blob, bytes, path.join(sampleDirectory, "model.sldprt"));
  const cfb = model.bytes.subarray(0, 8).toString("hex") === "d0cf11e0a1b11ae1";
  const framed = model.bytes.subarray(8).includes(Buffer.from("140006000800", "hex"));
  assert(cfb || framed, "Missing supported SolidWorks outer-container signature");
  await preserve(path.join(sampleDirectory, "LICENSE.txt"), license.bytes);
  await preserve(path.join(sampleDirectory, "model.sldprt"), model.bytes);
  records.push({ id: `solidworks-sheetmetal-${index}`, sourceUrl: model.url, repository, commit,
    sourceGitBlob: blob, format: "SLDPRT", container: cfb ? "CFB" : "SolidWorks framed raw-DEFLATE",
    formatVersion: cfb ? "unverified: pending stream-level inspection" : `outer-container-${model.bytes.readUInt32BE(4)}; application version unverified`,
    unit: "mm (upstream repository declaration; parser verification pending)", expectedGeometry,
    expectedGeometryBasis: "upstream directory and README; not a measured topology oracle",
    relativePath: `part-${index}/model.sldprt`, bytes, sha256: digest(model.bytes),
    license: "MIT", licensePath: `part-${index}/LICENSE.txt`, licenseSource: license.url,
    licenseSha256: digest(license.bytes), usage: "Local parser qualification; redistribution requires accompanying MIT notice",
    qualification: "source-acquired; geometry not certified" });
}
const manifest = { schemaVersion: 1, source: `https://github.com/${repository}/tree/${commit}`, records };
await preserve(path.join(directory, "manifest.json"), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
console.log(JSON.stringify({ directory, samples: records.length, totalBytes: records.reduce((n, r) => n + r.bytes, 0), records }, null, 2));

async function fetchFrozen(relative, blob, size, cachedPath) {
  try {
    const bytes = await readFile(cachedPath);
    validateBytes(bytes, blob, size);
    return { url: sourceUrl(relative), bytes };
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await fetchOnce(relative, blob, size); }
    catch (error) {
      lastError = error;
      // Content/hash failures are authoritative and must never be retried away.
      if (error.code === "ERR_ASSERTION") throw error;
      console.error(`Download attempt ${attempt + 1}/4 failed: ${relative}: ${error.message}`);
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw lastError;
}
async function fetchOnce(relative, blob, size) {
  const url = sourceUrl(relative);
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  assert(response.ok && response.body, `HTTP ${response.status}: ${url}`);
  const chunks = []; let received = 0;
  for await (const chunk of response.body) {
    received += chunk.byteLength; assert(received <= size, `Oversized download: ${url}`); chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  validateBytes(bytes, blob, size);
  return { url, bytes };
}
function validateBytes(bytes, blob, size) {
  assert.equal(bytes.length, size, "Truncated source");
  assert.equal(createHash("sha1").update(`blob ${size}\0`).update(bytes).digest("hex"), blob, "Source Git blob mismatch");
}
function sourceUrl(relative) { return `https://raw.githubusercontent.com/${repository}/${commit}/${relative.split("/").map(encodeURIComponent).join("/")}`; }
function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function preserve(target, bytes) {
  try { assert.deepEqual(await readFile(target), bytes, `Existing source differs: ${target}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; await writeFile(target, bytes, { flag: "wx" }); }
}
