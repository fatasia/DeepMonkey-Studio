import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bundleRoot = fileURLToPath(new URL("../src-tauri/target/release/bundle/", import.meta.url));
const desktopExecutable = fileURLToPath(new URL("../src-tauri/target/release/bim-studio-desktop.exe", import.meta.url));
const webDist = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const localApiBundle = fileURLToPath(new URL("../local-api-bundle/", import.meta.url));
const tauriConfigPath = fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url));
const expectedDirectories = ["nsis", "msi"];
const requiredLocalResources = [
  "index.html",
  "wasm/web-ifc.wasm",
  "wasm/web-ifc-mt.wasm",
  "draco/draco_decoder.wasm",
  "draco/draco_decoder_gltf.wasm",
  "draco/draco_wasm_wrapper.js",
  "engine-wasm/deep_engine_wasm.js",
  "engine-wasm/deep_engine_wasm_bg.wasm",
];
const issues = [];
const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
const expectedArtifactPrefix = `${tauriConfig.productName}_${tauriConfig.version}_`;
const packagedArtifacts = [];

if (tauriConfig.build?.frontendDist !== "../../web/dist") {
  issues.push("桌面生产入口必须使用本地 Web dist，不能加载远程页面");
}
const mainWindow = tauriConfig.app?.windows?.find((window) => window.label === "main");
if (JSON.stringify(mainWindow?.backgroundColor) !== JSON.stringify([11, 17, 20, 255])) {
  issues.push("桌面主窗口与 WebView 创建前必须使用产品深色背景，避免原生白色首帧");
}
const webviewMode = tauriConfig.bundle?.windows?.webviewInstallMode?.type;
if (!["offlineInstaller", "fixedRuntime"].includes(webviewMode)) {
  issues.push(`WebView2 安装模式 ${webviewMode ?? "未配置"} 仍依赖联网，完全离线包只允许 offlineInstaller/fixedRuntime`);
}

for (const directory of expectedDirectories) {
  const absoluteDirectory = path.join(bundleRoot, directory);
  if (!existsSync(absoluteDirectory)) {
    issues.push(`缺少 ${directory} 安装包目录`);
    continue;
  }

  const artifacts = readdirSync(absoluteDirectory).filter((name) =>
    name.startsWith(expectedArtifactPrefix) && /\.(exe|msi)$/i.test(name)
  );
  if (artifacts.length === 0) {
    issues.push(`${directory} 目录没有当前产品与版本的安装包（${expectedArtifactPrefix}*）`);
    continue;
  }

  for (const artifact of artifacts) {
    const artifactPath = path.join(absoluteDirectory, artifact);
    const size = statSync(artifactPath).size;
    if (size < 1024 * 1024) issues.push(`${artifact} 体积异常（${size} bytes）`);
    packagedArtifacts.push(artifactPath);
  }
}

if (!existsSync(desktopExecutable) || statSync(desktopExecutable).size < 1024 * 1024) {
  issues.push("缺少或未生成桌面主程序");
}

for (const resource of ["package.json", "dist/index.js", "publication-runtime.json",
  "publication/native/deep-engine-native.exe", "publication/native/runtime-package-probe.json",
  "publication/android/deep-scene-viewer-template.apk", "publication/android/build-tools/zipalign.exe",
  "publication/android/build-tools/lib/apksigner.jar", "publication/android/jre/bin/java.exe",
  process.platform === "win32" ? "node.exe" : "node"]) {
  const pathToResource = path.join(localApiBundle, resource);
  if (!existsSync(pathToResource) || statSync(pathToResource).size === 0) {
    issues.push(`缺少本地完整 API 运行资源：${resource}`);
  }
}

const publicationManifestPath = path.join(localApiBundle, "publication-runtime.json");
if (existsSync(publicationManifestPath)) {
  const manifest = JSON.parse(readFileSync(publicationManifestPath, "utf8"));
  if (manifest.schema !== "deep-monkey.local-publication-runtime" || manifest.schemaVersion !== 1) {
    issues.push("本地发布资源清单版本无效");
  }
  if (manifest.threeWebview?.installedBundleAvailable !== true
    || manifest.environment?.THREE_SCENE_VIEWER_LAUNCHER_EXECUTABLE !== "@runtime:current-executable") {
    issues.push("Three WebView 安装版必须声明通用启动器能力与当前程序路径映射");
  }
}

for (const resource of requiredLocalResources) {
  const pathToResource = path.join(webDist, resource);
  if (!existsSync(pathToResource) || statSync(pathToResource).size === 0) {
    issues.push(`缺少本地打包资源：${resource}`);
  }
}

const indexPath = path.join(webDist, "index.html");
if (existsSync(indexPath)) {
  const indexHtml = readFileSync(indexPath, "utf8");
  if (/(?:src|href)=["']https?:\/\//i.test(indexHtml)) {
    issues.push("生产 index.html 含远程脚本或样式依赖");
  }
  if (!/html,\s*body,\s*#root\s*\{[^}]*background:\s*#0b1114/i.test(indexHtml)) {
    issues.push("生产 index.html 未在脚本与外部 CSS 运行前覆盖深色首帧");
  }
}

if (existsSync(desktopExecutable)) {
  const executableTime = statSync(desktopExecutable).mtimeMs;
  const newestLocalResourceTime = Math.max(...requiredLocalResources
    .map((resource) => path.join(webDist, resource))
    .filter(existsSync)
    .map((resource) => statSync(resource).mtimeMs));
  // 安装包必须来自当前前端产物；只检查“文件存在”会让旧包在新构建后继续假通过。
  if (executableTime < newestLocalResourceTime) issues.push("桌面主程序早于当前 Web 产物，请重新执行 desktop:bundle");
  for (const artifact of packagedArtifacts) {
    // Tauri 会在生成每种安装包时再次标记 exe，因此最终 exe 可能晚于安装包；以前端产物为共同基线。
    if (statSync(artifact).mtimeMs < newestLocalResourceTime) issues.push(`${path.basename(artifact)} 早于当前 Web 产物，请重新打包`);
  }
}

if (issues.length > 0) {
  console.error("桌面安装包验收失败：");
  for (const issue of issues) console.error(`- ${issue}`);
  process.exitCode = 1;
} else {
  console.log(`桌面安装包与本地运行资源验收通过：${bundleRoot}`);
}
