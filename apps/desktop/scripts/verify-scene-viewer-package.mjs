import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { assertSceneViewerViteManifest, sha256 } from "./scene-viewer-package-core.mjs";

const buildRoot = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("用法：node verify-scene-viewer-package.mjs <build-root>");

const frontend = path.join(buildRoot, "frontend");
const manifestPath = path.join(frontend, "delivery", "scene-viewer.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const html = await readFile(path.join(frontend, "index.html"), "utf8");
const viteManifest = JSON.parse(await readFile(path.join(frontend, ".vite", "manifest.json"), "utf8"));

assert(manifest.kind === "industrial-studio-scene-viewer", "交付清单类型错误");
assert(manifest.deliveryTarget === "windows-scene-viewer", "交付目标必须是 Windows 只读客户端");
assert(["webgl", "webgpu-preferred"].includes(manifest.rendererMode), "rendererMode 必须与 deliveryTarget 分离");
assert(manifest.publication.publishedAt === manifest.publishedAt, "发布时间戳不一致");
assert(manifest.publication.snapshot.id === manifest.publication.sceneId, "场景 ID 不一致");
assert(manifest.publicationSha256 === sha256(JSON.stringify(manifest.publication)), "发布快照摘要不一致");
assert(manifest.projectSha256 === sha256(JSON.stringify(manifest.project)), "项目资源摘要不一致");
assert(html.includes('meta name="scene-viewer-delivery"'), "index.html 未锁定只读交付入口");
assertSceneViewerViteManifest(viteManifest);

for (const asset of manifest.assets) {
  assert(/^\/delivery\/assets\/[a-f0-9]{16}-/.test(asset.localUrl), `本地资源路径无效：${asset.localUrl}`);
  const filePath = path.join(frontend, asset.localUrl.replace(/^\//, ""));
  const content = await readFile(filePath);
  const metadata = await stat(filePath);
  assert(metadata.size === asset.bytes, `资源大小不一致：${asset.localUrl}`);
  assert(sha256(content) === asset.sha256, `资源摘要不一致：${asset.localUrl}`);
}

for (const model of manifest.project.models) {
  assert(model.status === "ready", `模型未就绪：${model.name}`);
  assert(model.manifest?.geometryUrl?.startsWith("/delivery/assets/"), `模型几何未固化：${model.name}`);
  for (const url of [model.manifest?.propertiesUrl, model.manifest?.hierarchyUrl, model.manifest?.pmiUrl, ...(model.manifest?.lods ?? []).map((lod) => lod.url)]) {
    if (url) assert(url.startsWith("/delivery/assets/"), `模型附属资源未固化：${url}`);
  }
}

const configPath = path.resolve(buildRoot, "..", "..", "src-tauri", "scene-viewer.generated.conf.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
assert(config.app?.security?.capabilities?.join(",") === "scene-viewer", "Tauri 未使用只读 capability");
assert(!JSON.stringify(config).includes("desktop-main"), "只读包意外继承编辑器 capability");
const csp = config.app?.security?.csp ?? "";
assert(/connect-src\s+'self'\s+ipc:;/.test(csp), "只读包 CSP 未限制为本地资源和 Tauri IPC");
assert(!/connect-src[^;]*(?:https?:|wss?:)/.test(csp), "只读包 CSP 意外允许远程网络连接");

process.stdout.write(`${JSON.stringify({
  ok: true,
  packageId: manifest.packageId,
  sceneId: manifest.publication.sceneId,
  publishedAt: manifest.publishedAt,
  rendererMode: manifest.rendererMode,
  toolbarVisible: manifest.toolbarVisible,
  assets: manifest.assets.length,
  assetBytes: manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0),
}, null, 2)}\n`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
