import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";

// T00 多资产车间切片:从仓内冻结的 Kenney Factory Kit 3.0(CC0)压缩包提取 7 个新资产,
// 将共享 colormap.png 内嵌进各 GLB buffer(与 prepareT00S1Factory.mjs 同一派生算法,
// 不改动网格/材质/节点),写入 lab/assets 并打印逐项统计。源与归档哈希在此冻结,
// 派生哈希由 lab/factoryWorkshop.ts 的 EXPECTED_WORKSHOP_ASSET_SHA256 复核。
const root = fileURLToPath(new URL("../../../", import.meta.url));
const archivePath = join(root, "data/external-assets/open-packs/factory.zip");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const align4 = value => Math.ceil(value / 4) * 4;

const ARCHIVE_SHA256 = "7e31fb2308e90304672bd15cd18fa9d9f02c03731a8cbc57a8e3e1c181dfb0a7";
const COLORMAP_SHA256 = "35d7bd6900dde0208429eeaec87fa17fbf024ed59f3f4eab54bc92802eba9dd7";
const ASSETS = Object.freeze([
  { file: "conveyor.glb", output: "WorkshopConveyor.glb", role: "assembly conveyor line",
    sha256: "879c75a74fdf972326f3f177738d893bce79bafc2f0f557cc5e84adcfda6d6d5" },
  { file: "box-large.glb", output: "WorkshopCrate.glb", role: "pallet crate / container",
    sha256: "f5c7a7b4d7ec48c2695dc5241d62a38dbb54b487e6be0f089548582c91bacdfd" },
  { file: "hopper-square.glb", output: "WorkshopHopper.glb", role: "material hopper",
    sha256: "1b88e30011629015cea65777c5157026088ea557163bee43596d5083f1df0f39" },
  { file: "structure-high.glb", output: "WorkshopColumn.glb", role: "building structure column",
    sha256: "3893a7eac2e676d40283372754aba868d6cdc2bc0894f68f3d558f0878d242c2" },
  { file: "catwalk-straight.glb", output: "WorkshopCatwalk.glb", role: "elevated catwalk segment",
    sha256: "85797c6ce53e3f4373bc59ecd3ce951a3f6b707651def5e0bae46756051cd18d" },
  { file: "robot-arm-a.glb", output: "WorkshopRobotArm.glb", role: "handling robot arm (9 mesh nodes)",
    sha256: "ad3f766791adadd1cfb5ccc27d2b2ac8787848282f2a15b3c407f350dc281b68" },
  { file: "screen-flat.glb", output: "WorkshopScreen.glb", role: "wall monitoring screen",
    sha256: "5d4ff7eace6f6c1164f00e4d68d615e1e5b61b34b7e6d826537dd1968c8c2a88" },
]);

const archive = await readFile(archivePath);
if (sha256(archive) !== ARCHIVE_SHA256) throw new Error("Kenney Factory Kit archive identity changed.");

const wanted = new Set([...ASSETS.map(asset => `Models/GLB format/${asset.file}`), "Models/GLB format/Textures/colormap.png"]);
const found = await new Promise((resolve, reject) => {
  yauzl.fromBuffer(archive, { lazyEntries: true }, (error, zip) => {
    if (error || !zip) { reject(error ?? new Error("Factory archive cannot be opened.")); return; }
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
const image = found.get("Models/GLB format/Textures/colormap.png");
if (sha256(image) !== COLORMAP_SHA256) throw new Error("Kenney colormap texture identity changed.");

function embedColormap(glb, image) {
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
  return { bytes: output, document };
}

const results = [];
for (const asset of ASSETS) {
  const glb = found.get(`Models/GLB format/${asset.file}`);
  if (sha256(glb) !== asset.sha256) throw new Error(`Kenney ${asset.file} identity changed.`);
  const { bytes: output, document } = embedColormap(glb, image);
  let triangles = 0, primitives = 0;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of document.meshes) for (const primitive of mesh.primitives) {
    primitives++;
    const position = document.accessors[primitive.attributes.POSITION];
    const indices = document.accessors[primitive.indices];
    triangles += indices.count / 3;
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], position.min[axis]); max[axis] = Math.max(max[axis], position.max[axis]);
    }
  }
  let meshNodes = 0;
  const countNode = index => {
    const node = document.nodes[index];
    let count = node.mesh !== undefined ? 1 : 0;
    for (const child of node.children ?? []) count += countNode(child);
    return count;
  };
  for (const sceneNode of document.scenes[0].nodes ?? []) meshNodes += countNode(sceneNode);
  await mkdir(join(root, "packages/deep-engine/lab/assets"), { recursive: true });
  await writeFile(join(root, "packages/deep-engine/lab/assets", asset.output), output);
  results.push({ output: asset.output, role: asset.role, sourceFile: asset.file,
    sourceSha256: asset.sha256, derivedSha256: sha256(output), derivedBytes: output.length,
    triangles, primitives, meshes: document.meshes.length, meshNodes, materials: document.materials.length,
    textures: document.images.length,
    bounds: { min: min.map(value => Number(value.toFixed(9))), max: max.map(value => Number(value.toFixed(9))) } });
}

const license = `# WorkshopKit.LICENSE.md — T00 多资产车间基准派生资产

来源:Kenney Factory Kit 3.0(https://kenney.nl/assets/factory-kit),许可 CC0-1.0。
仓内源压缩包 \`data/external-assets/open-packs/factory.zip\`,SHA-256
\`${ARCHIVE_SHA256}\`;派生算法与 \`FactoryMachine.glb\`(prepareT00S1Factory.mjs)相同:
仅将共享 \`Textures/colormap.png\`(SHA-256 \`${COLORMAP_SHA256}\`)内嵌进 GLB buffer,
不改网格、材质、节点与单位。下列派生 GLB 的 SHA-256 由
\`packages/deep-engine/lab/factoryWorkshop.ts\` 在浏览器侧复核,由本脚本
\`prepareT00Workshop.mjs\` 确定性再生。

${results.map(item => `- \`${item.output}\`(源 \`${item.sourceFile}\`,${item.triangles} 三角形,${item.primitives} 图元,${item.meshes} mesh,${item.meshNodes} mesh 节点)SHA-256 \`${item.derivedSha256}\``).join("\n")}
`;
await writeFile(join(root, "packages/deep-engine/lab/assets/WorkshopKit.LICENSE.md"), license);
console.log(JSON.stringify({ archiveSha256: sha256(archive), colormapSha256: sha256(image), assets: results }, null, 2));
