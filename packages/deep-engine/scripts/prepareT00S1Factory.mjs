import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const archivePath = join(root, "data/external-assets/open-packs/factory.zip");
const outputPath = join(root, "packages/deep-engine/lab/assets/FactoryMachine.glb");
const archive = await readFile(archivePath);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
if (sha256(archive) !== "7e31fb2308e90304672bd15cd18fa9d9f02c03731a8cbc57a8e3e1c181dfb0a7")
  throw new Error("Kenney Factory Kit archive identity changed.");

const entries = await new Promise((resolve, reject) => {
  yauzl.fromBuffer(archive, { lazyEntries: true }, (error, zip) => {
    if (error || !zip) { reject(error ?? new Error("Factory archive cannot be opened.")); return; }
    const wanted = new Set(["Models/GLB format/machine.glb", "Models/GLB format/Textures/colormap.png"]);
    const found = new Map();
    zip.on("entry", entry => {
      if (!wanted.has(entry.fileName)) { zip.readEntry(); return; }
      zip.openReadStream(entry, (streamError, stream) => {
        if (streamError || !stream) { reject(streamError ?? new Error("Factory archive entry cannot be read.")); return; }
        const chunks = [];
        stream.on("data", chunk => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => { found.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
      });
    });
    zip.on("end", () => found.size === wanted.size ? resolve(found) : reject(new Error("Factory archive entries missing.")));
    zip.on("error", reject); zip.readEntry();
  });
});
const glb = entries.get("Models/GLB format/machine.glb");
const image = entries.get("Models/GLB format/Textures/colormap.png");
if (sha256(glb) !== "a39e3042bcb7789274428357383317d70e1c31906e5301c99e7d9e90ac584863")
  throw new Error("Kenney machine GLB identity changed.");
if (sha256(image) !== "35d7bd6900dde0208429eeaec87fa17fbf024ed59f3f4eab54bc92802eba9dd7")
  throw new Error("Kenney machine texture identity changed.");
if (glb.readUInt32LE(0) !== 0x46546c67 || glb.readUInt32LE(4) !== 2 || glb.readUInt32LE(8) !== glb.length)
  throw new Error("Factory source is not GLB 2.0.");
const jsonBytes = glb.readUInt32LE(12);
if (glb.readUInt32LE(16) !== 0x4e4f534a) throw new Error("Missing source GLB JSON chunk.");
const document = JSON.parse(glb.subarray(20, 20 + jsonBytes).toString("utf8"));
const binaryHeader = 20 + jsonBytes;
const binaryBytes = glb.readUInt32LE(binaryHeader);
if (glb.readUInt32LE(binaryHeader + 4) !== 0x004e4942 || binaryHeader + 8 + binaryBytes !== glb.length)
  throw new Error("Missing source GLB binary chunk.");
if (document.buffers?.length !== 1 || document.images?.length !== 1
  || document.images[0].uri !== "Textures/colormap.png") throw new Error("Factory source layout changed.");
const used = document.buffers[0].byteLength;
if (!Number.isSafeInteger(used) || used > binaryBytes) throw new Error("Invalid source buffer length.");
const align4 = value => Math.ceil(value / 4) * 4;
const imageOffset = align4(used);
document.bufferViews.push({ buffer: 0, byteOffset: imageOffset, byteLength: image.length });
document.images[0] = { bufferView: document.bufferViews.length - 1, mimeType: "image/png", name: "colormap" };
document.buffers[0].byteLength = imageOffset + image.length;
const json = Buffer.from(JSON.stringify(document));
const paddedJson = Buffer.concat([json, Buffer.alloc(align4(json.length) - json.length, 0x20)]);
const binary = Buffer.concat([glb.subarray(binaryHeader + 8, binaryHeader + 8 + used),
  Buffer.alloc(imageOffset - used), image, Buffer.alloc(align4(image.length) - image.length)]);
const output = Buffer.alloc(12 + 8 + paddedJson.length + 8 + binary.length);
output.writeUInt32LE(0x46546c67, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8);
output.writeUInt32LE(paddedJson.length, 12); output.writeUInt32LE(0x4e4f534a, 16);
paddedJson.copy(output, 20);
const next = 20 + paddedJson.length;
output.writeUInt32LE(binary.length, next); output.writeUInt32LE(0x004e4942, next + 4);
binary.copy(output, next + 8);
if (sha256(output) !== "7fd1f33c2b4cd6f9fbfe3cc1769cbc8aeb04c21c46d610d5d0105a21ef2995b4")
  throw new Error("Factory benchmark derivative identity changed.");
await mkdir(join(root, "packages/deep-engine/lab/assets"), { recursive: true });
await writeFile(outputPath, output);
console.log(JSON.stringify({ archiveSha256: sha256(archive), sourceGlbSha256: sha256(glb),
  textureSha256: sha256(image), derivedGlbSha256: sha256(output), derivedGlbBytes: output.length,
  output: outputPath }, null, 2));
