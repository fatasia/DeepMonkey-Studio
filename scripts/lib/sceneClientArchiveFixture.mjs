import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { indexSceneClientArchiveFiles } from "../../apps/web/src/delivery/sceneClientPackageIndex.ts";

const requireWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const JSZip = requireWeb("jszip");
const { runtimeContentSha256 } = await import(pathToFileURL(requireWeb.resolve("@bim-studio/deep-engine/runtime-package")).href);

export async function archiveFixture({ compression = "STORE", streamFiles = false, payloads = [], editZip, editManifest } = {}) {
  const files = [
    { path: "scene.json", content: JSON.stringify({ id: "scene", projectId: "project", name: "场景" }) },
    { path: "project.json", content: JSON.stringify({ id: "project", name: "项目" }) },
    { path: "applications.json", content: "[]" }, { path: "runtime.json", content: "{}" },
    { path: "README.txt", content: "客户端归档校验夹具" }, ...payloads,
  ];
  const entries = await indexSceneClientArchiveFiles(files);
  const metadata = { kind: "bim-studio-scene-client-package", schemaVersion: 1, purpose: "delivery", target: "three-webview",
    renderer: "webgl", toolbarVisible: true, projectId: "project", sceneId: "scene", sceneName: "测试场景", publishedAt: null,
    capabilities: { twoD: true, threeD: true, dataBindings: true, liveConnections: true } };
  const manifest = { ...metadata, generatedAt: "2026-09-15T00:00:00.000Z", files: entries,
    contentHash: { algorithm: "sha256", value: runtimeContentSha256({ metadata,
      files: entries.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) }) } };
  editManifest?.(manifest);
  const zip = new JSZip();
  for (const file of files) zip.file(file.path, file.content);
  zip.file("manifest.json", JSON.stringify(manifest));
  editZip?.(zip);
  return { buffer: await zip.generateAsync({ type: "nodebuffer", compression, streamFiles, platform: "UNIX" }), manifest, files };
}

/** 修改生成器产出的 central/local 元数据；不实现 ZIP 解析器，只制造反例。 */
export function centralEntries(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("Fixture lacks EOCD");
  let offset = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < buffer.readUInt16LE(end + 10); index++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Fixture central signature mismatch");
    const length = buffer.readUInt16LE(offset + 28);
    entries.push({ name: buffer.toString("utf8", offset + 46, offset + 46 + length), offset, local: buffer.readUInt32LE(offset + 42) });
    offset += 46 + length + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  return entries;
}

export function renameRawEntry(buffer, from, to) {
  if (Buffer.byteLength(from) !== Buffer.byteLength(to)) throw new Error("Fixture rename must preserve byte length");
  const changed = Buffer.from(buffer), entry = centralEntries(changed).find(value => value.name === from);
  if (!entry) throw new Error(`Missing fixture entry ${from}`);
  changed.write(to, entry.offset + 46, "utf8"); changed.write(to, entry.local + 30, "utf8");
  return changed;
}
