import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = fileURLToPath(new URL("../", import.meta.url));
const web = path.join(root, "apps/web/public/brand");
const desktop = path.join(root, "apps/desktop/src-tauri/icons");
const source = await readFile(path.join(web, "logo-source.png"));
const metadata = await sharp(source).metadata();
// 选定母版的主体边界为 x=212..1046、y=153..1070；收紧留白并保留安全边距。
const frame = { left: 139, top: 121, width: 980, height: 980 };
const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}" viewBox="${frame.left} ${frame.top} ${frame.width} ${frame.height}"><title>DeepMonkey Studio</title><image width="${metadata.width}" height="${metadata.height}" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${source.toString("base64")}"/></svg>\n`);
const check = process.argv.includes("--check") || new URL(import.meta.url).searchParams.has("verify");
const images = new Map();

// 保留用户选定母版的材质，所有平台等比缩放并保留透明背景。
async function png(size) {
  if (!images.has(size)) images.set(size, await sharp(source).extract(frame).resize(size, size, { fit: "contain", background: "#00000000" }).png().toBuffer());
  return images.get(size);
}

async function output(file, bytes) {
  if (check) {
    if (!(await readFile(file)).equals(bytes)) throw new Error(`品牌资源未同步：${path.relative(root, file)}`);
  } else await writeFile(file, bytes);
}

await output(path.join(web, "app-icon-industrial.svg"), svg);
await output(path.join(web, "logo-industrial.svg"), svg);
for (const name of ["app-icon.png", "app-icon-chroma.png", "logo-transparent.png"]) {
  await output(path.join(web, name), await png(1024));
}
for (const [name, size] of [["32x32.png", 32], ["128x128.png", 128], ["128x128@2x.png", 256]]) {
  await output(path.join(desktop, name), await png(size));
}

const sizes = [16, 24, 32, 48, 64, 256];
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
const payloads = [];
let offset = header.length;
for (const [index, size] of sizes.entries()) {
  const bytes = await png(size), entry = 6 + index * 16;
  header[entry] = header[entry + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(bytes.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += bytes.length;
  payloads.push(bytes);
}
await output(path.join(desktop, "icon.ico"), Buffer.concat([header, ...payloads]));

const chunks = [];
for (const [type, size] of [["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024]]) {
  const bytes = await png(size), chunk = Buffer.alloc(8);
  chunk.write(type, 0, "ascii");
  chunk.writeUInt32BE(bytes.length + 8, 4);
  chunks.push(chunk, bytes);
}
const icns = Buffer.alloc(8);
icns.write("icns", 0, "ascii");
icns.writeUInt32BE(8 + chunks.reduce((sum, bytes) => sum + bytes.length, 0), 4);
await output(path.join(desktop, "icon.icns"), Buffer.concat([icns, ...chunks]));
console.log(`Product SVG / PNG / ICO / ICNS ${check ? "verified" : "generated"}.`);
